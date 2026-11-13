import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { isEnvRef } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import { latestUsAnalysis } from '../analysis/us-analysis.ts';
import { loadModules, matchModules, projectDir, projectSummary } from '../knowledge/modules.ts';
import { loadStaging } from '../knowledge/staging.ts';
import { loadSystemMap, mapIndex } from '../knowledge/system-map.ts';
import { normalize } from '../guard/classify.ts';
import { type DigestCache, type JiraDigest } from '../sources/digest.ts';
import type { Db } from '../state/db.ts';
import { FREE_MISSION_PREFIX } from '../state/store.ts';

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

export interface ContextDeps {
  rootDir: string;
  config: Config;
  db: Db;
  cache: DigestCache;
  env?: NodeJS.ProcessEnv;
}

/**
 * Monta o Context Package de um card: o mínimo para começar a raciocinar, com ponteiros
 * (não conteúdo) para o que pode ser buscado depois — progressive disclosure.
 * Exige o digest Jira do card já em cache.
 */
export function buildContextPackage(deps: ContextDeps, issueKey: string, options: { project?: string } = {}) {
  const { rootDir, config, db, cache } = deps;
  const env = deps.env ?? process.env;

  const lookup = cache.get('jira', issueKey, undefined, { internal: true });
  if (!lookup.hit) {
    throw new ContextError(`sem digest de ${issueKey}: leia o card pelo Atlassian MCP e grave com digest_put antes de context_build`);
  }
  const issue = lookup.digest as JiraDigest;
  const prefix = issueKey.split('-')[0]!;
  // Missão sem card não tem chave de projeto: o projeto vem do pedido (o do ambiente da URL).
  const free = prefix === FREE_MISSION_PREFIX;
  if (free && !options.project) throw new ContextError(`${issueKey} é missão sem card: informe project (o do ambiente da URL)`);
  const projectEntry = Object.entries(config.projects).find(([id, p]) => (free ? id === options.project : p.jiraKeys.includes(prefix)));
  if (!projectEntry) {
    throw new ContextError(free
      ? `projeto ${options.project} não existe em config/projects.yaml — cadastre o projeto antes`
      : `nenhum projeto em config/projects.yaml tem a chave ${prefix} — cadastre o projeto antes`);
  }
  const [projectId, project] = projectEntry;

  // Ambientes do projeto e o que falta no .env (só nomes): o /qa pede antes de testar.
  const environments = Object.entries(config.environments)
    .filter(([, e]) => e.project === projectId)
    .map(([id, e]) => {
      const vars = [isEnvRef(e.baseUrl) ? e.baseUrl.env : undefined, ...Object.values(e.roles).flatMap((r) => [isEnvRef(r.username) ? r.username.env : undefined, r.password.env])]
        .filter((v): v is string => v !== undefined);
      const missing = vars.filter((v) => !env[v]);
      return { id, type: e.type, roles: Object.keys(e.roles), allowDataCreation: e.allowDataCreation, ...(e.mfa ? { mfa: true } : {}), ...(e.captcha ? { captcha: true } : {}), ...(missing.length ? { missingEnv: missing } : {}) };
    });

  // Conhecimento: só o índice e os módulos que casam com o card.
  const loaded = loadModules(rootDir, projectId);
  const valid = loaded.flatMap((l) => (l.module ? [l.module] : []));
  const matched = matchModules(valid, [issue.title, ...issue.components, ...issue.labels]);
  const modules = matched.map((m) => {
    const counts: Record<string, number> = {};
    for (const s of m.statements) counts[s.status] = (counts[s.status] ?? 0) + 1;
    const cachedVersion = m.source.type === 'confluence' || m.source.type === 'jira' ? cache.cachedVersion(m.source.type, m.source.reference) : undefined;
    const stale = m.source.version !== undefined && cachedVersion !== undefined && cachedVersion !== m.source.version;
    const execPath = join(projectDir(rootDir, projectId), 'execution', `${m.module}.json`);
    const execEntries = existsSync(execPath) ? (JSON.parse(readFileSync(execPath, 'utf8')) as unknown[]).length : 0;
    return {
      name: m.module,
      file: `knowledge/${projectId}/modules/${m.module}.yaml`,
      statements: counts,
      risks: m.statements.filter((s) => s.kind === 'risk' || s.kind === 'regression').slice(0, 5).map((s) => s.statement),
      ...(execEntries ? { executionKnowledge: execEntries } : {}),
      // Resumo cuja fonte mudou não vale como CONFIRMED até ser regenerado (D6).
      ...(stale ? { stale: `fonte ${m.source.type}:${m.source.reference} está na versão ${cachedVersion}; o resumo é da ${m.source.version}` } : {}),
    };
  });

  // Aprendido em testes anteriores e ainda não revisado: volta para o agente marcado como tal (antes só o
  // promovido voltava, e nada era promovido). Card: só os módulos que casam; missão sem card: todos.
  const haystack = ` ${normalize([issue.title, ...issue.components, ...issue.labels].join(' ')).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const staged = loadStaging(rootDir, projectId).filter((s) => s.proposals.length);
  const stagedMatched = free ? staged : staged.filter((s) => haystack.includes(` ${normalize(s.module.replace(/-/g, ' '))} `));
  const rank = { business_rule: 0, risk: 1, regression: 2, permission: 3, behavior: 4 } as Record<string, number>;
  const unreviewed = stagedMatched.map((s) => ({
    name: s.module,
    file: `knowledge/${projectId}/_staging/${s.module}.yaml`,
    total: s.proposals.length,
    // O que mais muda o plano primeiro: regras confirmadas pelo usuário, riscos e regressões.
    statements: [...s.proposals].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)).slice(0, free ? 4 : 10)
      .map((p) => `[${p.kind}/${p.status}] ${p.statement}`),
  }));
  const map = loadSystemMap(rootDir, projectId);
  const questions = (db.prepare(`SELECT text, status, answer, run_id FROM questions WHERE project = ? AND (status = 'OPEN' OR status = 'DISMISSED') ORDER BY id DESC LIMIT 12`)
    .all(projectId) as { text: string; status: string; answer: string | null; run_id: string }[])
    .map((q) => `[${q.status === 'OPEN' ? 'em aberto' : `dispensada: ${q.answer}`}] ${q.text}`);

  // O que o card referencia e ainda não está em cache: candidatos a buscar, se necessário.
  const linked = issue.links.map((l) => ({ key: l.key, relation: l.relation, cached: cache.cachedVersion('jira', l.key) !== undefined }));
  const confluence = issue.confluence.map((c) => ({ ref: c.ref, title: c.title, cached: cache.cachedVersion('confluence', c.ref) !== undefined }));

  const history = (db
    .prepare('SELECT id, mode, status, recommendation FROM runs WHERE issue_key = ? ORDER BY started_at DESC LIMIT 3')
    .all(issueKey) as { id: string; mode: string; status: string; recommendation: string | null }[])
    .map((r) => {
      const failed = (db.prepare(`SELECT code FROM scenarios WHERE run_id = ? AND status IN ('FAILED','BLOCKED','NEEDS_REVIEW')`).all(r.id) as { code: string }[]).map((s) => s.code);
      return { ...r, ...(failed.length ? { notPassed: failed } : {}) };
    });

  const analysis = analysisOf(db, issueKey, lookup.version);

  return {
    issue: {
      key: issue.key, title: issue.title, type: issue.type, status: issue.status,
      ...(issue.priority ? { priority: issue.priority } : {}),
      ...(issue.parent ? { parent: issue.parent.key } : {}),
      components: issue.components, labels: issue.labels,
      summary: issue.summary,
      acceptanceCriteria: issue.acceptanceCriteria,
      businessRules: issue.businessRules,
      roles: issue.roles,
      openQuestions: issue.openQuestions,
      // Comentários mudam a estratégia (ex.: "dev diz que funciona na develop atualizada") — não podem ficar de fora.
      comments: issue.comments,
      environmentHints: issue.environmentHints,
      digestVersion: lookup.version,
    },
    project: { id: projectId, name: project.name, language: project.language, summary: projectSummary(rootDir, projectId) ?? null },
    environments,
    knowledge: {
      modulesAvailable: valid.map((m) => m.module),
      matched: modules,
      // Não revisado por humano: use para planejar e explorar, mas trate como pista, não como regra (salvo CONFIRMED de fonte manual, que o usuário afirmou).
      ...(unreviewed.length ? { unreviewed } : {}),
      ...(staged.length && !unreviewed.length ? { unreviewedModules: staged.map((s) => s.module) } : {}),
      ...(loaded.some((l) => l.error) ? { invalidFiles: loaded.filter((l) => l.error).map((l) => `${l.file}: ${l.error}`) } : {}),
    },
    references: {
      linkedIssues: linked,
      confluence,
      figma: issue.figma,
      attachments: issue.attachments.map((a) => `${a.name} (${a.kind})`),
    },
    history,
    ...(analysis ? { analysis } : {}),
    // Mapa do sistema (modo descoberta): onde ficam as coisas. Detalhe de uma tela: leia o arquivo.
    ...(map ? { systemMap: mapIndex(map) } : { systemMap: null }),
    ...(questions.length ? { pendingQuestions: questions } : {}),
  };
}

/** Última análise da US (/analisar), compacta: o /qa parte das lacunas e do rascunho dela. */
function analysisOf(db: Db, issueKey: string, digestVersion: string | undefined) {
  const a = latestUsAnalysis(db, issueKey);
  if (!a) return null;
  return {
    createdAt: a.createdAt,
    report: a.report,
    // Card mudou depois da análise: lacunas podem já ter sido respondidas.
    ...(a.cardVersion && digestVersion && a.cardVersion !== digestVersion ? { stale: `análise feita na versão ${a.cardVersion} do card; o digest atual é ${digestVersion}` } : {}),
    gaps: a.gaps.map((g) => `${g.criterion ? `${g.criterion} ` : ''}[${g.kind}] ${g.text}`),
    questions: a.questions.map((q) => q.text),
    risks: a.risks.map((r) => `${r.area}: ${r.text}${r.regressionOf ? ` (regressão de ${r.regressionOf})` : ''}`),
    draftScenarios: a.draftScenarios.map((s) => `${s.code} ${s.priority}/${s.risk} ${s.title}`),
  };
}

export function renderContextPackage(pkg: ReturnType<typeof buildContextPackage>): { yaml: string; approxTokens: number } {
  const yaml = stringify(pkg, { lineWidth: 0 });
  return { yaml, approxTokens: Math.ceil(yaml.length / 4) };
}
