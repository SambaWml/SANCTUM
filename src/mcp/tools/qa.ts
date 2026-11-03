import { stringify } from 'yaml';
import { z } from 'zod';
import type { BrowserService } from '../../browser/service.ts';
import { reloadConfig } from '../../config/runtime.ts';
import type { Config } from '../../config/schema.ts';
import { executionHints } from '../../knowledge/execution.ts';
import { proposeKnowledge, ProposedStatement } from '../../knowledge/staging.ts';
import { computeRunMetrics, formatMetrics } from '../../metrics/run-metrics.ts';
import { ingestTranscripts } from '../../metrics/transcripts.ts';
import { buildReport, SEVERITIES } from '../../reporting/report.ts';
import type { Redactor } from '../../security/redact.ts';
import type { SecretStore } from '../../security/secrets.ts';
import type { DigestCache, JiraDigest } from '../../sources/digest.ts';
import type { Db } from '../../state/db.ts';
import { StateError, type StateStore } from '../../state/store.ts';
import { ToolContent, type RegisterTool } from '../tooling.ts';

export interface QaDeps {
  rootDir: string;
  config: Config;
  db: Db;
  store: StateStore;
  cache: DigestCache;
  redactor: Redactor;
  secrets?: SecretStore;
  browser?: BrowserService;
  /** Pastas de transcript do Claude Code deste projeto (fonte do uso de tokens). */
  transcriptDirs?: string[];
}

export function registerQaTools(tool: RegisterTool, deps: QaDeps): void {
  const { rootDir, config, store, cache } = deps;

  tool(
    'batch_brief',
    'Briefing do próximo lote de cenários para um test-executor (YAML): ambiente, estado do navegador, critérios do card, ' +
      'cenários do lote (tamanho conforme o risco) e execution knowledge do módulo. Vazio quando não há cenários pendentes. ' +
      'compact=true: só run, navegador e cenários — para o executor que já recebeu critérios, regras e conhecimento neste run.',
    { runId: z.string(), compact: z.boolean().optional() },
    (a) => {
      const run = store.getRun(a.runId);
      const batch = store.nextBatch(run.id, config.policy.execution.batchSize);
      const status = store.runStatus(run.id);
      if (batch.length === 0) return { runId: run.id, progress: status.progress, batch: [], note: 'nenhum cenário pendente' };

      const env = config.environments[run.env]!;
      const modules = JSON.parse(run.modules) as string[];
      const digest = cache.get('jira', run.issue_key, undefined, { internal: true });
      const issue = digest.hit ? (digest.digest as JiraDigest) : undefined;
      const brief = {
        run: { id: run.id, issue: run.issue_key, mode: run.mode, progress: status.progress },
        environment: { id: run.env, type: env.type, allowDataCreation: env.allowDataCreation, roles: Object.keys(env.roles), ...(env.notes ? { notes: env.notes } : {}) },
        browser: deps.browser?.status() ?? { open: false },
        ...(a.compact ? { note: 'lote compacto: critérios, regras e execution knowledge são os do primeiro brief deste run' } : {
          issue: issue && {
            title: issue.title,
            acceptanceCriteria: issue.acceptanceCriteria,
            businessRules: issue.businessRules,
            ...(issue.environmentHints.length ? { environmentHints: issue.environmentHints } : {}),
          },
        }),
        batch: batch.map((s) => ({
          code: s.code, title: s.title, priority: s.priority, risk: s.risk, types: s.types,
          // Cenário interrompido: diz o que já foi verificado para não refazer.
          ...(s.status === 'IN_PROGRESS' ? { resume: store.scenarioProgress(s.id) } : {}),
          ...(s.parent_code ? { parent: s.parent_code } : {}),
          ...(s.preconditions ? { preconditions: s.preconditions } : {}),
          steps: s.steps, expected: s.expected,
        })),
        ...(a.compact ? {} : { executionKnowledge: executionHints(rootDir, run.project, modules) }),
      };
      store.logEvent(run.id, null, 'batch.brief', { codes: batch.map((s) => s.code) });
      return new ToolContent([{ type: 'text', text: stringify(brief, { lineWidth: 0 }) }]);
    },
  );

  tool(
    'plan_view',
    'Plano de um run (por runId ou chave do card → run mais recente) em YAML compacto: status do run e de cada cenário.',
    { runIdOrKey: z.string() },
    (a) => {
      const run = store.resolveRun(a.runIdOrKey);
      const view = {
        run: { id: run.id, issue: run.issue_key, env: run.env, mode: run.mode, status: run.status, ...(run.parent_run_id ? { parent: run.parent_run_id } : {}) },
        modules: JSON.parse(run.modules) as string[],
        scenarios: store.scenarioDetails(run.id).map((s) =>
          `${s.code} [${s.priority}/${s.risk}] ${s.title} — ${s.status}${s.classification ? ` (${s.classification})` : ''}`),
      };
      return new ToolContent([{ type: 'text', text: stringify(view, { lineWidth: 0 }) }]);
    },
  );

  tool(
    'retest_seed',
    'Base do reteste (run em modo retest, ainda em PLANNING): cenários que não passaram no run pai, com o que foi observado, ' +
      'e a lista dos que passaram (para escolher vizinhos de risco). Mantenha os códigos do pai; novos cenários seguem a numeração.',
    { runId: z.string() },
    (a) => {
      const run = store.getRun(a.runId);
      if (run.mode !== 'retest' || !run.parent_run_id) throw new StateError('retest_seed exige run em modo retest (run_start com parentRunId)');
      const parent = store.getRun(run.parent_run_id);
      const scenarios = store.scenarioDetails(parent.id);
      const notPassed = scenarios.filter((s) => s.status !== 'PASSED');
      const lastNumber = Math.max(0, ...scenarios.map((s) => Number(/^CT-(\d+)$/.exec(s.code)?.[1] ?? 0)));
      const seed = {
        parent: { id: parent.id, recommendation: parent.recommendation, summary: parent.summary },
        modules: JSON.parse(parent.modules) as string[],
        retest: notPassed.map((s) => ({
          code: s.code, title: s.title, priority: s.priority, risk: s.risk, types: s.types,
          ...(s.preconditions ? { preconditions: s.preconditions } : {}),
          steps: s.steps, expected: s.expected,
          before: { status: s.status, ...(s.classification ? { classification: s.classification } : {}), ...(s.observed ? { observed: s.observed } : {}), ...(s.reason ? { reason: s.reason } : {}) },
        })),
        passedBefore: scenarios.filter((s) => s.status === 'PASSED').map((s) => `${s.code} [${s.priority}/${s.risk}] ${s.title}`),
        nextCode: `CT-${String(lastNumber + 1).padStart(3, '0')}`,
      };
      return new ToolContent([{ type: 'text', text: stringify(seed, { lineWidth: 0 }) }]);
    },
  );

  tool(
    'report_build',
    'Gera reports/<card>/<runId>.md e .html (cenários, falhas com evidências, guard, limpeza, métricas, rascunho de comentário Jira) e devolve o resumo para o terminal. ' +
      'explanations: um item por problema, em linguagem simples para quem não acompanhou o teste (onde/como ver, o que acontece, o que o card pede, ressalva). ' +
      'summaries: um por cenário (todos, inclusive os que passaram), em linguagem simples para um dev de fora: veredito, o que foi visto, para onde olhar; ' +
      'severity e jira (card criado) alimentam o filtro e os selos do HTML. Ambos ficam salvos no run e somam por código (o mais recente de cada código vale); removeExplanations tira explicações por código; ' +
      'missingSummaries lista os cenários ainda sem resumo.',
    {
      runId: z.string(),
      removeExplanations: z.array(z.string()).optional().describe('códigos cujas explicações saem do relatório (ex.: achado que deixou de ser bug)'),
      // Aceita JSON em texto: cliente com schema em cache (antes do recarregamento do servidor) envia assim.
      explanations: z.preprocess((v) => (typeof v === 'string' ? JSON.parse(v) : v), z.array(z.object({
        code: z.string().describe('cenário de origem, ex.: CT-003'),
        title: z.string().min(3),
        howToSee: z.string().min(3),
        happens: z.string().min(3),
        expected: z.string().min(3),
        note: z.string().optional(),
        severity: z.enum(SEVERITIES).optional(),
        jira: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).optional().describe('card de bug criado, ex.: GURUJA-9239'),
      })).optional()),
      summaries: z.preprocess((v) => (typeof v === 'string' ? JSON.parse(v) : v), z.array(z.object({
        code: z.string(),
        verdict: z.string().min(3).describe('ex.: "Passou", "Bug (alta)", "Não é bug (decisão do QA lead)"'),
        text: z.string().min(10).describe('o que foi visto, sem jargão, com exemplo concreto'),
        next: z.string().optional().describe('para onde olhar / o que decidir'),
        severity: z.enum(SEVERITIES).optional(),
        jira: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).optional(),
      })).optional()),
    },
    (a) => {
      if (a.explanations) {
        for (const e of a.explanations) store.getScenario(a.runId, e.code);
        store.logEvent(a.runId, null, 'report.explain', a.explanations);
      }
      if (a.removeExplanations?.length) store.logEvent(a.runId, null, 'report.explain_remove', a.removeExplanations);
      if (a.summaries) {
        for (const s of a.summaries) store.getScenario(a.runId, s.code);
        store.logEvent(a.runId, null, 'report.summaries', a.summaries);
      }
      // Uso de modelo vem dos transcripts do Claude Code; a chamada em curso pode ainda não estar gravada.
      ingestTranscripts(deps.db, deps.transcriptDirs ?? []);
      const metrics = computeRunMetrics(deps.db, store, a.runId);
      const report = buildReport({ db: deps.db, store, cache, rootDir, redactor: deps.redactor, metrics }, a.runId);
      return { ...report, metrics: formatMetrics(metrics) };
    },
  );

  tool(
    'metrics_run',
    'Métricas de um run (runId ou chave do card): tokens novos e de cache, por cenário/bug/decisão útil, tempo, cache de contexto, ações e screenshots.',
    { runIdOrKey: z.string() },
    (a) => {
      ingestTranscripts(deps.db, deps.transcriptDirs ?? []);
      return computeRunMetrics(deps.db, store, store.resolveRun(a.runIdOrKey).id);
    },
  );

  tool(
    'knowledge_propose',
    'Propõe conhecimento reutilizável do módulo para revisão humana (knowledge/<projeto>/_staging). Regras: business_rule só com fonte ' +
      'documental; observação do teste é OBSERVED/INFERRED/SUSPECTED com source {type:"run", reference: runId}; bug observado vira regression, nunca regra.',
    { runId: z.string(), module: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), statements: z.array(ProposedStatement).min(1) },
    (a) => proposeKnowledge(rootDir, store.getRun(a.runId).project, a.module, a.runId, a.statements),
  );

  if (deps.secrets) {
    const secrets = deps.secrets;
    tool(
      'config_reload',
      'Recarrega .env e config/*.yaml (ex.: depois de cadastrar um ambiente) e diz o que ainda falta no .env (só nomes).',
      {},
      () => reloadConfig({ rootDir, config, secrets, redactor: deps.redactor }),
    );
  }
}
