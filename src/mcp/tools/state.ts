import { z } from 'zod';
import type { BrowserService } from '../../browser/service.ts';
import { writeExecutionKnowledge } from '../../knowledge/execution.ts';
import { CLASSIFICATIONS, CONFIDENCE_LEVELS, FINAL_STATUSES } from '../../state/rules.ts';
import { loadSystemMap } from '../../knowledge/system-map.ts';
import { planCoverage } from '../../state/coverage.ts';
import { checkPlanQuality, MIN_EXPLORATORY } from '../../state/plan-quality.ts';
import { StateError, type StateStore } from '../../state/store.ts';
import type { RegisterTool } from '../tooling.ts';

const priority = z.enum(['P0', 'P1', 'P2', 'P3']);
const risk = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const charterFields = {
  target: z.string().min(3).describe('a tela, fluxo ou risco a explorar (ex.: "Checkout: pagamento recusado e volta")'),
  tours: z.array(z.string().min(3)).min(1).describe('testes a aplicar (ex.: estados vazio/erro com network_simulate, outro papel, voltar/recarregar, IDs na URL, celular)'),
  persona: z.string().optional().describe('ex.: aluno novo sem histórico, admin apressado'),
  timeboxMin: z.number().int().min(10).max(120).optional().describe('padrão 45'),
  origin: z.string().optional().describe('de onde veio o foco: lacuna/risco da análise, risco do módulo, bug antigo'),
};
const scenarioFields = {
  title: z.string().min(3),
  priority,
  risk,
  types: z.array(z.string()).describe('ex.: functional, permission, validation, regression'),
  preconditions: z.string().optional(),
  steps: z.array(z.string()).min(1),
  expected: z.string().min(3),
};

export function registerStateTools(tool: RegisterTool, deps: { store: StateStore; rootDir: string; browser?: BrowserService; cardOf?: (issueKey: string) => { criteria: string[]; linkedBugs: string[] } }): void {
  const { store, rootDir, browser } = deps;

  tool(
    'run_start',
    'Inicia um run de QA para um card. Retorna runId.',
    {
      issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
      env: z.string().describe('id em config/environments.yaml'),
      mode: z.enum(['manual', 'explore', 'automate', 'retest']),
      parentRunId: z.string().optional().describe('obrigatório em retest'),
    },
    (a) => {
      const run = store.startRun(a);
      return { runId: run.id, status: run.status };
    },
  );

  tool(
    'run_status',
    'Progresso de um run (por runId ou chave do card → run mais recente): contagens, em andamento, próximo cenário.',
    { runIdOrKey: z.string() },
    (a) => store.runStatus(a.runIdOrKey),
  );

  tool(
    'run_complete',
    'Conclui o run (exige todos os cenários com status final), grava o execution knowledge e fecha o navegador. A recomendação não pode passar do teto calculado pelos cenários: PRODUCT_BUG em P0/P1 → só REPROVADO; P0/P1 FAILED/BLOCKED/NEEDS_REVIEW ou nenhum PASSED → no máximo INCONCLUSIVO. ' +
      'Missão sem card (EXPLORA-*) não aprova nem reprova: a recomendação é ignorada e o relatório mostra os achados. ' +
      'Exploração: teste normal ≥1 charter fechado, exploratório ≥2 (charter_start/charter_end).',
    {
      runId: z.string(),
      recommendation: z.enum(['APROVADO', 'REPROVADO', 'INCONCLUSIVO']).optional().describe('obrigatória em card; ignorada em missão sem card'),
      summary: z.string().min(3),
      noExplorationReason: z.string().min(10).optional()
        .describe('só se não deu para explorar (padrão: teste normal ≥1 charter fechado, exploratório ≥2)'),
    },
    async (a) => {
      // Padrão Sanctum: exploração em sessões com foco (charters), fechadas com o que cobriram.
      const current = store.getRun(a.runId);
      const min = MIN_EXPLORATORY[current.mode] ?? 0;
      // Sessão fechada antes da hora (shortReason) fica no relatório, mas não conta como exploração feita.
      const explored = store.listCharters(a.runId).filter((c) => c.status === 'CLOSED' && !c.summary?.short).length;
      if (explored < min && !a.noExplorationReason) {
        throw new StateError(`padrão Sanctum: ${current.mode === 'explore' ? 'exploratório' : 'teste'} pede ao menos ${min} charter(s) fechado(s) — há ${explored}. ` +
          'Abra uma sessão com charter_start em volta do risco maior (o que o card não cobre, estados de erro/vazio, telas vizinhas, outro papel), explore e feche com charter_end; ou informe noExplorationReason.');
      }
      if (explored < min) store.logEvent(a.runId, null, 'run.exploration_waived', { reason: a.noExplorationReason, explored, min });
      const run = store.completeRun(a.runId, a.recommendation ?? null, a.summary);
      const knowledge = writeExecutionKnowledge(rootDir, store, run);
      await browser?.close();
      return { runId: run.id, status: run.status, executionKnowledge: knowledge };
    },
  );

  tool(
    'run_abort',
    'Aborta um run ativo.',
    { runId: z.string(), reason: z.string().min(3) },
    async (a) => {
      const run = store.abortRun(a.runId, a.reason);
      await browser?.close();
      return { runId: run.id, status: run.status };
    },
  );

  tool(
    'plan_save',
    'Salva/substitui o plano (cenários CT-NNN, em ordem de execução). Deixa o run aguardando aprovação humana. ' +
      'modules: módulos de conhecimento do card (o primeiro recebe o execution knowledge do run). ' +
      'Padrão Sanctum (recusado se faltar): pré-condição em todo cenário; esperado verificável; todo CA com cenário (cite o CA no título); ' +
      'com risco HIGH, ao menos um negative/permission/validation; cada bug ligado ao card com cenário de regressão citando a chave. ' +
      'Exploração não é CT com roteiro: vai em charters (sessões com alvo, testes e tempo; exploratório ≥2). ' +
      'Missão exploratória: exige o mapa do sistema (system_map_save) e nenhuma pergunta em aberto (question_ask/question_answer). ' +
      'Exceção só com waivers [{ item: "CA03" | "negative" | "PROJ-123" | "charters", reason }], mostrados ao usuário. Modelo: references/plan-example.md.',
    {
      runId: z.string(),
      scenarios: z.array(z.object({ code: z.string(), ...scenarioFields })).min(1),
      charters: z.array(z.object(charterFields)).optional().describe('sessões exploratórias planejadas (CH-01…), aprovadas junto com o plano'),
      modules: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).optional(),
      waivers: z.array(z.object({ item: z.string().min(2), reason: z.string().min(5) })).optional(),
    },
    (a) => {
      const run = store.getRun(a.runId);
      const card = deps.cardOf?.(run.issue_key) ?? { criteria: [], linkedBugs: [] };
      const quality = checkPlanQuality(a.scenarios, { mode: run.mode, ...card, waivers: a.waivers ?? [], charters: a.charters?.length ?? 0 });
      // Modo descoberta: quem explora planeja em cima do que mapeou e do que o usuário respondeu.
      if (run.mode === 'explore') {
        const waived = (item: string) => (a.waivers ?? []).some((w) => w.item.toLowerCase() === item);
        if (!waived('map') && !loadSystemMap(rootDir, run.project)) {
          quality.problems.push(`o projeto ${run.project} ainda não tem mapa do sistema: mapeie só olhando (browser_open abre para leitura antes do plano) e grave com system_map_save; projeto já testado: system_map_save com fromExecution: true`);
        }
        const open = store.listQuestions(run.id).filter((q) => q.status === 'OPEN');
        if (open.length) quality.problems.push(`${open.length} pergunta(s) ao usuário em aberto: mostre, espere a resposta e registre com question_answer (ou dismiss com o motivo) — ${open.map((q) => `#${q.id} ${q.text.slice(0, 60)}`).join(' | ')}`);
      }
      if (quality.problems.length) {
        throw new StateError(`plano fora do padrão Sanctum (nada foi salvo):\n- ${quality.problems.join('\n- ')}`);
      }
      const saved = store.savePlan(a.runId, a.scenarios, a.modules, a.charters ?? []);
      // Cobertura dos critérios do card: mostre ao usuário, com os CA sem cenário em destaque, antes de pedir aprovação.
      return {
        ...saved,
        ...(card.criteria.length ? { coverage: planCoverage(card.criteria, a.scenarios) } : {}),
        ...(quality.notes.length ? { notes: quality.notes } : {}),
      };
    },
  );

  tool(
    'plan_approve',
    'Registra a aprovação humana do plano. Chame somente depois que o usuário aprovar explicitamente.',
    { runId: z.string() },
    (a) => {
      const run = store.approvePlan(a.runId);
      return { runId: run.id, status: run.status };
    },
  );

  tool(
    'scenario_start',
    'Inicia (ou retoma) um cenário. Abre a janela de network/console/trace do cenário.',
    { runId: z.string(), code: z.string() },
    async (a) => {
      const s = store.startScenario(a.runId, a.code);
      await browser?.onScenarioStart(a.runId, a.code);
      return { code: s.code, status: s.status, resumed: s.resumed };
    },
  );

  tool(
    'scenario_reopen',
    'Reabre cenário BLOCKED/NOT_EXECUTED/NEEDS_REVIEW no mesmo run quando a causa deixou de existir (ex.: ambiente voltou). ' +
      'A tentativa anterior fica no histórico mas não conta para a conclusão. PASSED/FAILED não reabrem.',
    { runId: z.string(), code: z.string(), reason: z.string().min(10) },
    (a) => {
      const s = store.reopenScenario(a.runId, a.code, a.reason);
      return { code: s.code, status: s.status };
    },
  );

  tool(
    'scenario_reclassify',
    'Corrige status/classificação de um resultado FAILED/NEEDS_REVIEW/BLOCKED sem refazer o cenário (ex.: PRODUCT_BUG que é divergência de requisito → NEEDS_REVIEW/REQUIREMENT_AMBIGUITY). ' +
      'As regras de conclusão valem de novo; a mudança e a justificativa ficam no relatório. Use também após o run concluído (depois regere o relatório).',
    {
      runId: z.string(),
      code: z.string(),
      status: z.enum(['FAILED', 'NEEDS_REVIEW', 'BLOCKED']),
      classification: z.enum(CLASSIFICATIONS).optional(),
      observed: z.string().optional(),
      reason: z.string().optional(),
      justification: z.string().min(15),
    },
    (a) => {
      const { runId, code, justification, ...req } = a;
      return store.reclassifyScenario(runId, code, req, justification);
    },
  );

  tool(
    'scenario_add',
    'Registra um comportamento NOVO encontrado explorando (EXP-NNN), para executar com verificação. Exige origem: parentCode (cenário onde apareceu) ' +
      'ou um charter aberto. Não é EXP: lote/área (charter), reteste de bug (plano ou /retest), limpeza (cleanup_run), evidência (bug_evidence). ' +
      'Achado igual a bug já conhecido: cite a chave em vez de criar EXP.',
    { runId: z.string(), parentCode: z.string().optional(), ...scenarioFields },
    (a) => {
      const { runId, ...input } = a;
      const s = store.addExploratory(runId, input);
      return { code: s.code, status: s.status };
    },
  );

  tool(
    'charter_start',
    'Abre uma sessão exploratória (charter): um planejado (code: "CH-01") ou um novo (target, tours). Uma por vez; ' +
      'o EXP criado enquanto ela está aberta fica ligado a ela. Devolve o prazo (timebox, padrão 45 min).',
    { runId: z.string(), code: z.string().regex(/^CH-\d{2}$/).optional(), target: charterFields.target.optional(), tours: charterFields.tours.optional(), persona: charterFields.persona, timeboxMin: charterFields.timeboxMin, origin: charterFields.origin },
    (a) => {
      const { runId, ...input } = a;
      const c = store.startCharter(runId, input);
      return { ...c, next: 'Explore no foco do charter. Comportamento novo → scenario_add (vira EXP ligado ao charter) e execute com verify. No prazo, feche com charter_end.' };
    },
  );

  tool(
    'charter_end',
    'Fecha a sessão exploratória com o resumo: covered (telas, rotas e estados percorridos), tours (testes aplicados de fato), ' +
      'observations (usabilidade/layout/texto — não são bugs), questions (dúvidas para o PO), notes. Charter planejado não feito: skipReason. ' +
      'Só fecha com substância: ao menos 10 min, 15 ações/navegações, uma evidência (screenshot ou achado) e rastro de cada teste declarado ' +
      '(disse que simulou erro de rede → precisa ter chamado network_simulate). Não deu para continuar: shortReason (fica registrada, não conta como exploração).',
    {
      runId: z.string(), code: z.string().regex(/^CH-\d{2}$/),
      covered: z.array(z.string().min(3)).optional(), tours: z.array(z.string().min(3)).optional(),
      observations: z.array(z.string().min(3)).optional(), questions: z.array(z.string().min(3)).optional(),
      notes: z.string().optional(), skipReason: z.string().optional(), shortReason: z.string().optional(),
    },
    (a) => {
      const { runId, code, ...input } = a;
      const closed = store.endCharter(runId, code, input);
      browser?.onCharterEnd(runId);
      return closed;
    },
  );

  tool(
    'scenario_complete',
    'Conclui um cenário. PASSED/FAILED exigem verificações registradas por verify; confidence é calculada pela rubrica (a sua só pode rebaixar).',
    {
      runId: z.string(),
      code: z.string(),
      status: z.enum(FINAL_STATUSES),
      classification: z.enum(CLASSIFICATIONS).optional()
        .describe('OBSERVATION: usabilidade, layout, texto ou melhoria — com NEEDS_REVIEW ou PASSED; nunca bug, não segura a recomendação'),
      observed: z.string().optional(),
      reason: z.string().optional(),
      confidence: z.enum(CONFIDENCE_LEVELS).optional(),
    },
    async (a) => {
      const { runId, code, ...req } = a;
      const result = store.completeScenario(runId, code, req);
      await browser?.onScenarioEnd(runId, code, req.status);
      return result;
    },
  );
}
