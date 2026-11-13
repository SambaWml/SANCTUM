import type { Config } from '../config/schema.ts';
import { OPEN_CLEANUP, type CleanupSpec, type CleanupStatus, type CreatedDataRow } from './cleanup.ts';
import { transaction, type Db } from './db.ts';
import { activeMinutes as activeMinutesOf, CHARTER_MIN, checkCharterSubstance, type CharterFacts, type CharterMin } from './exploration.ts';

/** Chamadas que são exploração de fato (navegador); status, fechar sessão etc. não contam como atividade. */
const EXPLORE_ACTIVITY = ['tool.navigate', 'tool.snapshot', 'tool.act', 'tool.act_approved', 'tool.verify', 'tool.network', 'tool.console',
  'tool.screenshot', 'tool.browser_viewport', 'tool.network_simulate', 'tool.browser_open', 'network.simulate', 'browser.open'];
import {
  evaluateCompletion,
  FINAL_STATUSES,
  recommendationAllowed,
  recommendationCeiling,
  type Recommendation,
  type RecommendationFact,
  type Classification,
  type CompletionFacts,
  type CompletionRequest,
  type FinalStatus,
  type ScenarioStatus,
  type VerificationKind,
} from './rules.ts';

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

/**
 * Missão sem card (exploração de um sistema pela URL): chave EXPLORA-AAAAMMDDHHmm, aceita em
 * qualquer projeto. O "card" é o objetivo da missão, gravado como digest pelo /qa.
 */
export const FREE_MISSION_PREFIX = 'EXPLORA';

export type RunMode = 'manual' | 'explore' | 'automate' | 'retest';
export type RunStatus = 'PLANNING' | 'AWAITING_APPROVAL' | 'EXECUTING' | 'COMPLETED' | 'ABORTED';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Risk = 'HIGH' | 'MEDIUM' | 'LOW';

export interface RunRow {
  id: string;
  issue_key: string;
  project: string;
  env: string;
  mode: RunMode;
  parent_run_id: string | null;
  status: RunStatus;
  plan_approved_at: string | null;
  current_scenario: string | null;
  recommendation: string | null;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  /** JSON: módulos de conhecimento do run. */
  modules: string;
  /** JSON {client, version, model}: quem operou o run (metadado; não muda regra). */
  agent: string | null;
}

export interface AgentInfo {
  client?: string;
  version?: string;
  model?: string;
  /** Missão do painel ao vivo que lançou este agente (SANCTUM_MISSION). */
  mission?: string;
}

export interface ScenarioDetails extends ScenarioRow {
  types: string[];
  origin: string;
  parent_code: string | null;
  preconditions: string | null;
  steps: string[];
  expected: string;
  classification: string | null;
  confidence: string | null;
  observed: string | null;
  reason: string | null;
}

export interface ScenarioRow {
  id: number;
  run_id: string;
  code: string;
  title: string;
  priority: Priority;
  risk: Risk;
  status: ScenarioStatus;
  seq: number;
}

export interface ScenarioInput {
  code: string;
  title: string;
  priority: Priority;
  risk: Risk;
  types: string[];
  preconditions?: string;
  steps: string[];
  expected: string;
}

export interface ValidatedActionRow {
  action: string;
  target_json: string | null;
  value_ref: string | null;
  url: string | null;
  ts: string;
  scenario: string;
}

export type ExploratoryInput = Omit<ScenarioInput, 'code'> & { parentCode?: string };

/**
 * Charter: sessão exploratória com foco (alvo, persona, testes), tempo e resumo do que foi coberto
 * (auditoria do exploratório 09/11: o charter só existia no texto e a exploração virava roteiro).
 */
export interface CharterInput { target: string; persona?: string; tours: string[]; timeboxMin?: number; origin?: string }
export interface CharterSummary { covered: string[]; tours: string[]; observations: string[]; questions: string[]; notes?: string }
export interface CharterRow {
  code: string; target: string; persona: string | null; tours: string[]; origin: string | null; timeboxMin: number;
  status: 'PLANNED' | 'OPEN' | 'CLOSED' | 'SKIPPED'; startedAt: string | null; endedAt: string | null;
  summary: (CharterSummary & { minutes?: number; wallMinutes?: number; overrunMin?: number; findings?: string[]; skipped?: string; short?: string; thin?: string[] }) | null;
}
export const DEFAULT_TIMEBOX_MIN = 45;

export interface QuestionRow {
  id: number; project: string; module: string; text: string; options: string[]; about: string | null;
  status: 'OPEN' | 'ANSWERED' | 'DISMISSED'; answer: string | null; askedAt: string; answeredAt: string | null;
}

/**
 * EXP é comportamento novo achado explorando. Lote/área é charter; reteste de bug é regressão no plano
 * ou /retest; limpeza é cleanup_run; evidência de bug é bug_evidence (auditoria 09/11: títulos assim
 * eram 1 em cada 4 EXP).
 */
const NOT_AN_EXP: { re: RegExp; use: string }[] = [
  { re: /^\s*(lote|batch|bloco|rodada)\b/i, use: 'área/lote a explorar é um charter (charter_start), não um EXP' },
  { re: /\b(reteste|retest)\b/i, use: 'reteste de bug é cenário de regressão no plano (antes da aprovação) ou /retest' },
  { re: /\b(cleanup|limpeza|limpar dados)\b/i, use: 'limpeza é cleanup_run/data_register' },
  { re: /^\s*(evid[eê]ncia|gravar v[ií]deo|print)\b/i, use: 'evidência de bug é bug_evidence (ou screenshot no próprio cenário)' },
  { re: /^\s*(investigar e corrigir|corrigir)\b/i, use: 'correção não é teste; registre o achado no cenário onde apareceu' },
];

const ACTIVE_RUN: RunStatus[] = ['PLANNING', 'AWAITING_APPROVAL', 'EXECUTING'];

/** Volume de uma tentativa de cenário: aviso e trava (auditoria de fluxo 09/11: 243 ações em 2 cenários). */
export const LOOP_LIMITS = { warn: { actions: 60, verifications: 40 }, stop: { actions: 150, verifications: 100 } } as const;
const PLAN_CODE = /^CT-\d{2,4}$/;

export interface StoreOptions {
  now?: () => Date;
  /** Substância mínima de uma sessão exploratória (padrão CHARTER_MIN; os testes da ferramenta encurtam). */
  charterMin?: CharterMin;
}

export class StateStore {
  private readonly now: () => Date;
  private readonly charterMin: CharterMin;
  /** Agente da sessão MCP (clientInfo + SANCTUM_MODEL), gravado no run e nas aprovações. */
  agent: AgentInfo | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.charterMin = options.charterMin ?? CHARTER_MIN;
  }

  private ts(): string {
    return this.now().toISOString();
  }

  private agentJson(): string | null {
    return this.agent ? JSON.stringify(this.agent) : null;
  }

  // ── Runs ────────────────────────────────────────────────────────────

  startRun(input: { issueKey: string; env: string; mode: RunMode; parentRunId?: string }): RunRow {
    const env = this.config.environments[input.env];
    if (!env) throw new StateError(`ambiente "${input.env}" não existe em config/environments.yaml`);
    const project = this.config.projects[env.project]!;
    const prefix = input.issueKey.split('-')[0]!;
    if (prefix !== FREE_MISSION_PREFIX && project.jiraKeys.length > 0 && !project.jiraKeys.includes(prefix)) {
      throw new StateError(`${input.issueKey} não pertence ao projeto ${env.project} (chaves: ${project.jiraKeys.join(', ')})`);
    }

    const active = this.db
      .prepare(`SELECT id FROM runs WHERE issue_key = ? AND status IN (${ACTIVE_RUN.map(() => '?').join(',')})`)
      .get(input.issueKey, ...ACTIVE_RUN) as { id: string } | undefined;
    if (active) throw new StateError(`já existe run ativo ${active.id} para ${input.issueKey} — use /resume ou aborte-o`);

    if (input.mode === 'retest') {
      if (!input.parentRunId) throw new StateError('retest exige parentRunId');
      const parent = this.getRun(input.parentRunId);
      if (parent.issue_key !== input.issueKey || parent.status !== 'COMPLETED') {
        throw new StateError(`run pai ${parent.id} precisa ser do mesmo card e estar COMPLETED`);
      }
    }

    const started = this.ts();
    // 20261023T100000: o "T" impede que data+hora formem uma sequência longa de dígitos.
    const stamp = started.replace(/[-:]/g, '').slice(0, 15);
    let id = `${input.issueKey}-${stamp}`;
    for (let n = 2; this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(id); n++) id = `${input.issueKey}-${stamp}-${n}`;

    this.db
      .prepare(
        `INSERT INTO runs (id, issue_key, project, env, mode, parent_run_id, status, started_at, agent)
         VALUES (?, ?, ?, ?, ?, ?, 'PLANNING', ?, ?)`,
      )
      .run(id, input.issueKey, env.project, input.env, input.mode, input.parentRunId ?? null, started, this.agentJson());
    this.logEvent(id, null, 'run.start', { mode: input.mode, env: input.env, agent: this.agent });
    return this.getRun(id);
  }

  getRun(id: string): RunRow {
    const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!run) throw new StateError(`run ${id} não existe`);
    return run;
  }

  /** Aceita id de run ou chave do card (usa o run mais recente). */
  resolveRun(idOrKey: string): RunRow {
    const byId = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(idOrKey) as RunRow | undefined;
    if (byId) return byId;
    const latest = this.db
      .prepare('SELECT * FROM runs WHERE issue_key = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(idOrKey) as RunRow | undefined;
    if (!latest) throw new StateError(`nenhum run para ${idOrKey}`);
    return latest;
  }

  runStatus(idOrKey: string) {
    const run = this.resolveRun(idOrKey);
    const scenarios = this.listScenarios(run.id);
    const counts: Record<string, number> = {};
    for (const s of scenarios) counts[s.status] = (counts[s.status] ?? 0) + 1;
    const done = scenarios.filter((s) => (FINAL_STATUSES as readonly string[]).includes(s.status)).length;
    const inProgress = scenarios.filter((s) => s.status === 'IN_PROGRESS').map((s) => s.code);
    const next = inProgress[0] ?? scenarios.find((s) => s.status === 'PENDING')?.code ?? null;
    return {
      run: { id: run.id, issue: run.issue_key, env: run.env, mode: run.mode, status: run.status },
      progress: `${done}/${scenarios.length}`,
      counts,
      inProgress,
      next,
    };
  }

  /**
   * Conclui o run. Missão sem card (EXPLORA-*) não tem critério de aceite: não aprova nem reprova
   * (recomendação gravada como null; o relatório mostra o veredito de exploração).
   */
  completeRun(runId: string, recommendation: Recommendation | null, summary: string): RunRow {
    const run = this.getRun(runId);
    if (run.status !== 'EXECUTING') throw new StateError(`run está ${run.status}; só runs EXECUTING podem ser concluídos`);
    const charters = this.listCharters(runId);
    const openCharter = charters.find((c) => c.status === 'OPEN');
    if (openCharter) throw new StateError(`charter ${openCharter.code} ainda aberto — feche com charter_end (o que cobriu, testes, observações, perguntas)`);
    const planned = charters.filter((c) => c.status === 'PLANNED');
    if (planned.length) {
      throw new StateError(`charters planejados sem sessão: ${planned.map((c) => `${c.code} (${c.target})`).join(', ')} — rode (charter_start) ou pule com charter_end + skipReason`);
    }
    // EXP registrado e não explorado vira ideia não explorada (fica no resumo do charter, não segura o run).
    const idle = this.db.prepare(`SELECT id, code FROM scenarios WHERE run_id = ? AND origin = 'exploratory' AND status = 'PENDING'`).all(runId) as { id: number; code: string }[];
    for (const s of idle) {
      this.db.prepare(`UPDATE scenarios SET status = 'NOT_EXECUTED', reason = 'ideia registrada e não explorada', ended_at = ? WHERE id = ?`).run(this.ts(), s.id);
    }
    if (idle.length) this.logEvent(runId, null, 'exp.unexplored', idle.map((s) => s.code));
    const open = this.listScenarios(runId).filter((s) => s.status === 'PENDING' || s.status === 'IN_PROGRESS');
    if (open.length > 0) {
      throw new StateError(`cenários sem status final: ${open.map((s) => s.code).join(', ')} — conclua ou marque NOT_EXECUTED`);
    }
    const free = run.issue_key.startsWith(`${FREE_MISSION_PREFIX}-`);
    const gate = recommendationCeiling(this.recommendationFacts(runId));
    if (free) {
      recommendation = null;
    } else if (!recommendation) {
      throw new StateError('recomendação obrigatória (APROVADO, INCONCLUSIVO ou REPROVADO)');
    } else if (!recommendationAllowed(recommendation, gate.ceiling)) {
      throw new StateError(`recomendação ${recommendation} não permitida: o teto é ${gate.ceiling} (${gate.reasons.join('; ')})`);
    }
    const dirty = this.listCreatedData(runId).filter((d) => OPEN_CLEANUP.includes(d.cleanup_status));
    if (dirty.length > 0) {
      const list = dirty.map((d) => `#${d.id} ${d.resource}${d.ext_id ? ` (${d.ext_id})` : ''}: ${d.cleanup_status}`).join('; ');
      throw new StateError(`dados criados sem limpeza resolvida: ${list} — use data_register e cleanup_run (ou keep com motivo)`);
    }
    transaction(this.db, () => {
      this.db
        .prepare(`UPDATE runs SET status = 'COMPLETED', recommendation = ?, summary = ?, current_scenario = NULL, ended_at = ? WHERE id = ?`)
        .run(recommendation, summary, this.ts(), runId);
      this.logEvent(runId, null, 'run.complete', { recommendation, ceiling: gate.ceiling, reasons: gate.reasons });
    });
    return this.getRun(runId);
  }

  private recommendationFacts(runId: string): RecommendationFact[] {
    return this.db
      .prepare('SELECT code, priority, status, classification, confidence FROM scenarios WHERE run_id = ? ORDER BY seq')
      .all(runId) as unknown as RecommendationFact[];
  }

  abortRun(runId: string, reason: string): RunRow {
    const run = this.getRun(runId);
    if (!ACTIVE_RUN.includes(run.status)) throw new StateError(`run já está ${run.status}`);
    this.db
      .prepare(`UPDATE runs SET status = 'ABORTED', summary = ?, ended_at = ? WHERE id = ?`)
      .run(reason, this.ts(), runId);
    // Abortar não exige limpeza (é a saída de emergência), mas o que ficou pendente fica registrado.
    const pending = this.listCreatedData(runId).filter((d) => OPEN_CLEANUP.includes(d.cleanup_status))
      .map((d) => `#${d.id} ${d.resource}${d.ext_id ? ` (${d.ext_id})` : ''}: ${d.cleanup_status}`);
    this.logEvent(runId, null, 'run.abort', { reason, ...(pending.length ? { pendingData: pending } : {}) });
    return this.getRun(runId);
  }

  // ── Plano ───────────────────────────────────────────────────────────

  /** Salva (ou substitui) o plano. Só antes da aprovação; depois disso, use cenários exploratórios. */
  savePlan(runId: string, scenarios: ScenarioInput[], modules: string[] = [], charters: CharterInput[] = []): { count: number; charters: number; status: RunStatus } {
    const run = this.getRun(runId);
    if (run.status !== 'PLANNING' && run.status !== 'AWAITING_APPROVAL') {
      throw new StateError(`plano não pode mudar com run ${run.status}; use scenario_add para exploratórios`);
    }
    if (scenarios.length === 0) throw new StateError('plano vazio');
    const codes = new Set<string>();
    for (const s of scenarios) {
      if (!PLAN_CODE.test(s.code)) throw new StateError(`código inválido "${s.code}" (esperado CT-001)`);
      if (codes.has(s.code)) throw new StateError(`código duplicado ${s.code}`);
      codes.add(s.code);
    }

    const origin = run.mode === 'retest' ? 'retest' : 'planned';
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM scenarios WHERE run_id = ?').run(runId);
      const insert = this.db.prepare(
        `INSERT INTO scenarios (run_id, code, title, priority, types, risk, origin, preconditions, steps, expected, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      scenarios.forEach((s, i) =>
        insert.run(runId, s.code, s.title, s.priority, JSON.stringify(s.types), s.risk, origin,
          s.preconditions ?? null, JSON.stringify(s.steps), s.expected, i + 1),
      );
      this.db.prepare(`UPDATE runs SET status = 'AWAITING_APPROVAL', modules = ? WHERE id = ?`).run(JSON.stringify(modules), runId);
      this.db.prepare(`DELETE FROM charters WHERE run_id = ? AND status = 'PLANNED'`).run(runId);
      charters.forEach((c, i) => this.insertCharter(runId, `CH-${String(i + 1).padStart(2, '0')}`, c, 'PLANNED'));
    });
    this.logEvent(runId, null, 'plan.save', { count: scenarios.length, charters: charters.length });
    return { count: scenarios.length, charters: charters.length, status: 'AWAITING_APPROVAL' };
  }

  // ── Charters (exploração) ───────────────────────────────────────────

  private insertCharter(runId: string, code: string, c: CharterInput, status: 'PLANNED' | 'OPEN'): void {
    if (!c.target?.trim() || c.target.trim().length < 3) throw new StateError('charter exige target (a tela, fluxo ou risco a explorar)');
    if (!c.tours?.length) throw new StateError('charter exige ao menos um teste/tour (ex.: estados vazio e de erro, outro papel, voltar/recarregar)');
    const timebox = c.timeboxMin ?? DEFAULT_TIMEBOX_MIN;
    if (timebox < 10 || timebox > 120) throw new StateError('timeboxMin entre 10 e 120 minutos');
    this.db.prepare(`INSERT INTO charters (run_id, code, target, persona, tours, origin, timebox_min, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, code, c.target.trim(), c.persona ?? null, JSON.stringify(c.tours), c.origin ?? null, timebox, status, status === 'OPEN' ? this.ts() : null);
  }

  listCharters(runId: string): CharterRow[] {
    const rows = this.db.prepare(`SELECT * FROM charters WHERE run_id = ? ORDER BY code`).all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      code: String(r.code), target: String(r.target), persona: (r.persona as string | null) ?? null, tours: JSON.parse(String(r.tours)) as string[],
      origin: (r.origin as string | null) ?? null, timeboxMin: Number(r.timebox_min), status: r.status as CharterRow['status'],
      startedAt: (r.started_at as string | null) ?? null, endedAt: (r.ended_at as string | null) ?? null,
      summary: r.summary ? (JSON.parse(String(r.summary)) as CharterRow['summary']) : null,
    }));
  }

  /** Abre um charter planejado (code) ou um novo. Um por vez: o EXP criado enquanto ele está aberto fica ligado a ele. */
  startCharter(runId: string, input: { code?: string } & Partial<CharterInput>): CharterRow & { deadline: string } {
    this.requireExecuting(runId);
    const charters = this.listCharters(runId);
    const open = charters.find((c) => c.status === 'OPEN');
    if (open) throw new StateError(`charter ${open.code} ainda aberto — feche com charter_end antes de abrir outro`);
    let code = input.code;
    if (code) {
      const planned = charters.find((c) => c.code === code);
      if (!planned) throw new StateError(`charter ${code} não existe neste run`);
      if (planned.status !== 'PLANNED') throw new StateError(`charter ${code} está ${planned.status}`);
      this.db.prepare(`UPDATE charters SET status = 'OPEN', started_at = ?, persona = COALESCE(?, persona), timebox_min = COALESCE(?, timebox_min) WHERE run_id = ? AND code = ?`)
        .run(this.ts(), input.persona ?? null, input.timeboxMin ?? null, runId, code);
    } else {
      code = `CH-${String(charters.length + 1).padStart(2, '0')}`;
      this.insertCharter(runId, code, { target: input.target ?? '', persona: input.persona, tours: input.tours ?? [], timeboxMin: input.timeboxMin, origin: input.origin }, 'OPEN');
    }
    this.logEvent(runId, null, 'charter.start', { code });
    const row = this.listCharters(runId).find((c) => c.code === code)!;
    return { ...row, deadline: new Date(Date.parse(row.startedAt!) + row.timeboxMin * 60_000).toISOString() };
  }

  /** Fecha o charter com o resumo da sessão (ou pula um planejado, com motivo). */
  endCharter(runId: string, code: string, input: Partial<CharterSummary> & { skipReason?: string; shortReason?: string }): CharterRow {
    this.requireExecuting(runId);
    const c = this.listCharters(runId).find((x) => x.code === code);
    if (!c) throw new StateError(`charter ${code} não existe neste run`);
    const ts = this.ts();
    if (input.skipReason) {
      if (c.status !== 'PLANNED') throw new StateError(`só charter planejado pode ser pulado (${code} está ${c.status})`);
      if (input.skipReason.trim().length < 10) throw new StateError('skipReason: diga por que a sessão não foi feita');
      this.db.prepare(`UPDATE charters SET status = 'SKIPPED', ended_at = ?, summary = ? WHERE run_id = ? AND code = ?`)
        .run(ts, JSON.stringify({ covered: [], tours: [], observations: [], questions: [], skipped: input.skipReason.trim() }), runId, code);
      this.logEvent(runId, null, 'charter.skip', { code, reason: input.skipReason.trim() });
      return this.listCharters(runId).find((x) => x.code === code)!;
    }
    if (c.status !== 'OPEN') throw new StateError(`charter ${code} está ${c.status}; abra com charter_start`);
    if (!input.covered?.length) throw new StateError('charter_end exige covered: telas, rotas e estados que você realmente percorreu');
    if (!input.tours?.length) throw new StateError('charter_end exige tours: os testes que você aplicou de fato');
    const busy = this.db.prepare(`SELECT code FROM scenarios WHERE run_id = ? AND charter_code = ? AND status = 'IN_PROGRESS'`).get(runId, code) as { code: string } | undefined;
    if (busy) throw new StateError(`conclua ${busy.code} antes de fechar o charter`);
    const minutes = Math.round((Date.parse(ts) - Date.parse(c.startedAt!)) / 60_000); // relógio (prazo); a substância usa o tempo ativo
    const findings = (this.db.prepare(`SELECT code FROM scenarios WHERE run_id = ? AND charter_code = ? ORDER BY seq`).all(runId, code) as { code: string }[]).map((r) => r.code);
    // Substância: tempo, atividade, evidência e rastro dos testes declarados (ver exploration.ts).
    const since = c.startedAt!;
    const n = (sql: string, ...a: string[]) => Number((this.db.prepare(sql).get(runId, since, ...a) as { n: number }).n);
    const ev = (type: string) => n(`SELECT COUNT(*) n FROM events WHERE run_id = ? AND ts >= ? AND type = ?`, type);
    // Tempo com atividade: soma dos intervalos entre ações, verificações, prints e ferramentas de
    // inspeção, cada um limitado (13/11: o agente fazia 1 min e agendava 8 de espera). Espera parada não soma.
    const activityTs = (this.db.prepare(`
        SELECT ts FROM actions WHERE run_id = ? AND ts >= ? UNION ALL
        SELECT ts FROM verifications WHERE run_id = ? AND ts >= ? UNION ALL
        SELECT ts FROM evidence WHERE run_id = ? AND ts >= ? AND kind = 'screenshot' UNION ALL
        SELECT ts FROM events WHERE run_id = ? AND ts >= ? AND type IN (${EXPLORE_ACTIVITY.map((t) => `'${t}'`).join(',')})`)
      .all(runId, since, runId, since, runId, since, runId, since) as { ts: string }[]).map((r) => r.ts);
    const activeMinutes = activeMinutesOf(since, activityTs, this.charterMin.idleCapMin ?? CHARTER_MIN.idleCapMin);
    const facts: CharterFacts = {
      // Tempo explorando, não tempo de relógio (12/11: um agente agendou 400 s de espera para "cumprir" o mínimo).
      minutes: activeMinutes, findings: findings.length,
      actions: n(`SELECT COUNT(*) n FROM actions WHERE run_id = ? AND ts >= ? AND ok = 1`),
      navigations: ev('tool.navigate'),
      screenshots: n(`SELECT COUNT(*) n FROM evidence WHERE run_id = ? AND ts >= ? AND kind = 'screenshot'`),
      simulations: ev('network.simulate'), viewports: ev('tool.browser_viewport'),
      inspections: ev('tool.console') + ev('tool.network'), roleOpens: ev('browser.open'),
    };
    const thin = checkCharterSubstance(input.tours, facts, this.charterMin);
    const shortReason = input.shortReason?.trim();
    if (thin.length && !shortReason) {
      throw new StateError(`sessão ${code} ainda sem substância para fechar:\n- ${thin.join('\n- ')}\n` +
        'Continue explorando no foco do charter. Se não dá para continuar (ambiente caiu, área inacessível), feche com shortReason — a sessão fica registrada, mas não conta como exploração feita.');
    }
    if (shortReason && shortReason.length < 20) throw new StateError('shortReason: explique por que a sessão terminou antes (o que impediu)');
    const summary = {
      covered: input.covered, tours: input.tours, observations: input.observations ?? [], questions: input.questions ?? [],
      ...(input.notes ? { notes: input.notes } : {}), minutes: activeMinutes, findings,
      ...(minutes !== activeMinutes ? { wallMinutes: minutes } : {}),
      ...(minutes > c.timeboxMin ? { overrunMin: minutes - c.timeboxMin } : {}),
      ...(thin.length && shortReason ? { short: shortReason, thin } : {}),
    };
    this.db.prepare(`UPDATE charters SET status = 'CLOSED', ended_at = ?, summary = ? WHERE run_id = ? AND code = ?`).run(ts, JSON.stringify(summary), runId, code);
    this.logEvent(runId, null, 'charter.end', { code, minutes, findings: findings.length, ...(summary.short ? { short: true } : {}) });
    return this.listCharters(runId).find((x) => x.code === code)!;
  }

  /** Chamado só pela ferramenta plan_approve, que exige aprovação humana no Claude Code. */
  approvePlan(runId: string): RunRow {
    const run = this.getRun(runId);
    if (run.status !== 'AWAITING_APPROVAL') throw new StateError(`run está ${run.status}; nada a aprovar`);
    const ts = this.ts();
    transaction(this.db, () => {
      this.db.prepare(`UPDATE runs SET status = 'EXECUTING', plan_approved_at = ? WHERE id = ?`).run(ts, runId);
      this.db
        .prepare(`INSERT INTO approvals (run_id, action, target, level, decision, ts, agent) VALUES (?, 'plan', ?, 'PLAN', 'APPROVED', ?, ?)`)
        .run(runId, run.issue_key, ts, this.agentJson());
    });
    this.logEvent(runId, null, 'plan.approve', null);
    return this.getRun(runId);
  }

  // ── Cenários ────────────────────────────────────────────────────────

  listScenarios(runId: string): ScenarioRow[] {
    return this.db
      .prepare('SELECT id, run_id, code, title, priority, risk, status, seq FROM scenarios WHERE run_id = ? ORDER BY seq')
      .all(runId) as unknown as ScenarioRow[];
  }

  scenarioDetails(runId: string): ScenarioDetails[] {
    const rows = this.db.prepare('SELECT * FROM scenarios WHERE run_id = ? ORDER BY seq').all(runId) as unknown as (Omit<ScenarioDetails, 'types' | 'steps'> & { types: string; steps: string })[];
    return rows.map((r) => ({ ...r, types: JSON.parse(r.types) as string[], steps: JSON.parse(r.steps) as string[] }));
  }

  /**
   * Próximo lote para um test-executor (ARCHITECTURE.md D4): começa pelo cenário em andamento,
   * segue a ordem do plano e encolhe o lote quando entra cenário de risco maior.
   */
  nextBatch(runId: string, sizes: Record<Risk, number>): ScenarioDetails[] {
    const open = this.scenarioDetails(runId).filter((s) => s.status === 'IN_PROGRESS' || s.status === 'PENDING');
    open.sort((a, b) => (a.status === 'IN_PROGRESS' ? -1 : 0) - (b.status === 'IN_PROGRESS' ? -1 : 0) || a.seq - b.seq);
    const batch: ScenarioDetails[] = [];
    for (const s of open) {
      const limit = Math.min(...[...batch, s].map((x) => sizes[x.risk]));
      if (batch.length >= limit) break;
      batch.push(s);
    }
    return batch;
  }

  /** O que já foi feito num cenário (para retomar sem refazer): últimas verificações e nº de ações. */
  /**
   * Volume da tentativa atual do cenário (ações + verificações). Acima de LOOP_LIMITS.warn o agente
   * é avisado (e o evento scenario.loop marca o run no painel); acima de LOOP_LIMITS.stop o navegador
   * recusa novas ações até o cenário ser concluído ou reaberto — evita andar em círculo por horas.
   */
  scenarioLoad(scenarioId: number): { actions: number; verifications: number; level: 'ok' | 'warn' | 'stop' } {
    const since = this.attemptStart(scenarioId);
    const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scenario_id = ? AND ts >= ?`).get(scenarioId, since) as { n: number }).n;
    const actions = count('actions');
    const verifications = count('verifications');
    const level = actions >= LOOP_LIMITS.stop.actions || verifications >= LOOP_LIMITS.stop.verifications ? 'stop'
      : actions >= LOOP_LIMITS.warn.actions || verifications >= LOOP_LIMITS.warn.verifications ? 'warn' : 'ok';
    if (level !== 'ok') {
      const marked = this.db.prepare(`SELECT 1 FROM events WHERE scenario_id = ? AND type = 'scenario.loop' AND ts >= ? AND json_extract(payload, '$.level') = ?`).get(scenarioId, since, level);
      const runId = (this.db.prepare('SELECT run_id FROM scenarios WHERE id = ?').get(scenarioId) as { run_id: string }).run_id;
      if (!marked) this.logEvent(runId, scenarioId, 'scenario.loop', { level, actions, verifications });
    }
    return { actions, verifications, level };
  }

  scenarioProgress(scenarioId: number): { verified: string[]; actions: number } {
    const since = this.attemptStart(scenarioId);
    const rows = this.db
      .prepare('SELECT kind, description, passed FROM verifications WHERE scenario_id = ? AND ts >= ? ORDER BY id')
      .all(scenarioId, since) as { kind: string; description: string; passed: number }[];
    const latest = new Map<string, string>();
    for (const r of rows) latest.set(`${r.kind}|${r.description}`, `${r.kind}: ${r.description} (${r.passed ? 'passou' : 'reprovou'})`);
    const actions = (this.db.prepare('SELECT COUNT(*) AS n FROM actions WHERE scenario_id = ? AND ts >= ? AND ok = 1').get(scenarioId, since) as { n: number }).n;
    return { verified: [...latest.values()], actions };
  }

  getScenario(runId: string, code: string): ScenarioRow {
    const s = this.db
      .prepare('SELECT id, run_id, code, title, priority, risk, status, seq FROM scenarios WHERE run_id = ? AND code = ?')
      .get(runId, code) as ScenarioRow | undefined;
    if (!s) throw new StateError(`cenário ${code} não existe no run ${runId}`);
    return s;
  }

  private requireExecuting(runId: string): RunRow {
    const run = this.getRun(runId);
    if (run.status === 'AWAITING_APPROVAL') throw new StateError('plano aguardando aprovação humana (plan_approve)');
    if (run.status === 'COMPLETED') {
      throw new StateError('run está COMPLETED: o run já foi fechado. Para mudar o resultado de um cenário use scenario_reclassify; para testar de novo, /retest');
    }
    if (run.status !== 'EXECUTING') throw new StateError(`run está ${run.status}`);
    return run;
  }

  startScenario(runId: string, code: string): ScenarioRow & { resumed: boolean } {
    this.requireExecuting(runId);
    const s = this.getScenario(runId, code);
    if (s.status === 'IN_PROGRESS') return { ...s, resumed: true };
    if (s.status !== 'PENDING') throw new StateError(`${code} já está ${s.status}`);
    const other = this.listScenarios(runId).find((x) => x.status === 'IN_PROGRESS');
    if (other) throw new StateError(`conclua ${other.code} antes de iniciar ${code}`);

    const ts = this.ts();
    transaction(this.db, () => {
      this.db.prepare(`UPDATE scenarios SET status = 'IN_PROGRESS', started_at = ? WHERE id = ?`).run(ts, s.id);
      this.db.prepare('UPDATE runs SET current_scenario = ? WHERE id = ?').run(code, runId);
    });
    this.logEvent(runId, s.id, 'scenario.start', null);
    return { ...this.getScenario(runId, code), resumed: false };
  }

  /**
   * Reabre um cenário BLOCKED/NOT_EXECUTED/NEEDS_REVIEW no mesmo run (ex.: o ambiente voltou).
   * A tentativa anterior fica no histórico, mas deixa de contar: a próxima scenario_start abre
   * uma janela nova e só verificações/evidências dela valem para concluir. PASSED/FAILED não reabrem.
   */
  reopenScenario(runId: string, code: string, reason: string): ScenarioRow {
    this.requireExecuting(runId);
    const s = this.getScenario(runId, code);
    if (!['BLOCKED', 'NOT_EXECUTED', 'NEEDS_REVIEW'].includes(s.status)) {
      throw new StateError(`${code} está ${s.status}: só BLOCKED, NOT_EXECUTED ou NEEDS_REVIEW reabrem (resultado PASSED/FAILED vale; use /retest)`);
    }
    if (reason.trim().length < 10) throw new StateError('reopen exige motivo (o que mudou desde a tentativa anterior)');
    this.db
      .prepare(`UPDATE scenarios SET status = 'PENDING', classification = NULL, observed = NULL, reason = NULL, confidence = NULL, confidence_score = NULL, started_at = NULL, ended_at = NULL WHERE id = ?`)
      .run(s.id);
    this.logEvent(runId, s.id, 'scenario.reopen', { from: s.status, reason });
    return this.getScenario(runId, code);
  }

  /**
   * Corrige status/classificação de um resultado final (FAILED, NEEDS_REVIEW, BLOCKED) sem refazer
   * o cenário — ex.: o executor marcou PRODUCT_BUG o que é divergência de requisito. As regras de
   * conclusão valem de novo sobre as verificações da tentativa; a mudança fica registrada com o motivo.
   * Vale também com o run concluído (o relatório é regerado depois).
   */
  reclassifyScenario(runId: string, code: string, req: CompletionRequest, justification: string) {
    const run = this.getRun(runId);
    if (run.status !== 'EXECUTING' && run.status !== 'COMPLETED') throw new StateError(`run está ${run.status}`);
    const s = this.getScenario(runId, code);
    const allowed = ['FAILED', 'NEEDS_REVIEW', 'BLOCKED'];
    if (!allowed.includes(s.status) || !allowed.includes(req.status)) {
      throw new StateError(`reclassificação só entre ${allowed.join('/')} (${code} está ${s.status}; pedido: ${req.status})`);
    }
    if (justification.trim().length < 15) throw new StateError('reclassificação exige justificativa (por que a classificação anterior estava errada)');
    const before = this.db.prepare('SELECT status, classification, started_at FROM scenarios WHERE id = ?').get(s.id) as { status: string; classification: string | null; started_at: string | null };
    if (req.status === 'FAILED' && !before.started_at) {
      throw new StateError(`${code} nunca foi iniciado: FAILED exige uma tentativa executada (reabra e execute)`);
    }
    const result = evaluateCompletion(req, { ...this.completionFacts(s), currentStatus: 'IN_PROGRESS' });
    if (!result.ok) throw new StateError(`${code} não pode ser ${req.status}:\n- ${result.problems.join('\n- ')}`);
    const from = { status: before.status, classification: before.classification };
    const to = { status: req.status, classification: req.classification ?? null };
    // Mudança, evento e ajuste da recomendação na mesma transação: nada fica pela metade.
    return transaction(this.db, () => {
      this.db
        .prepare(`UPDATE scenarios SET status = ?, classification = ?, observed = COALESCE(?, observed), reason = COALESCE(?, reason), confidence = ?, confidence_score = ? WHERE id = ?`)
        .run(req.status, req.classification ?? null, req.observed ?? null, req.reason ?? null, result.confidence, result.score, s.id);
      this.logEvent(runId, s.id, 'scenario.reclassify', { from, to, justification });
      // Run já concluído: a recomendação gravada não pode ficar acima do novo teto.
      if (run.status === 'COMPLETED' && run.recommendation) {
        const gate = recommendationCeiling(this.recommendationFacts(runId));
        const current = run.recommendation as Recommendation;
        if (!recommendationAllowed(current, gate.ceiling)) {
          this.db.prepare('UPDATE runs SET recommendation = ? WHERE id = ?').run(gate.ceiling, runId);
          this.logEvent(runId, null, 'run.recommendation_lowered', { from: current, to: gate.ceiling, reasons: gate.reasons });
          return { code, from, to, recommendation: { from: current, to: gate.ceiling } };
        }
      }
      return { code, from, to };
    });
  }

  addExploratory(runId: string, input: ExploratoryInput): ScenarioRow {
    this.requireExecuting(runId);
    if (input.parentCode) this.getScenario(runId, input.parentCode);
    const misuse = NOT_AN_EXP.find((x) => x.re.test(input.title));
    if (misuse) throw new StateError(`"${input.title}" não é EXP: ${misuse.use}. EXP é um comportamento novo que você encontrou explorando.`);
    // Rastreável: nasce de um cenário (parentCode) ou da sessão exploratória aberta.
    const charter = this.listCharters(runId).find((c) => c.status === 'OPEN');
    if (!input.parentCode && !charter) {
      throw new StateError('EXP precisa de origem: parentCode (o cenário onde a anomalia apareceu) ou um charter aberto (charter_start)');
    }
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS seq,
                SUM(CASE WHEN origin = 'exploratory' THEN 1 ELSE 0 END) AS exp
         FROM scenarios WHERE run_id = ?`,
      )
      .get(runId) as { seq: number; exp: number | null };
    const code = `EXP-${String((row.exp ?? 0) + 1).padStart(3, '0')}`;
    this.db
      .prepare(
        `INSERT INTO scenarios (run_id, code, title, priority, types, risk, origin, parent_code, preconditions, steps, expected, seq, charter_code)
         VALUES (?, ?, ?, ?, ?, ?, 'exploratory', ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, code, input.title, input.priority, JSON.stringify(input.types), input.risk, input.parentCode ?? null,
        input.preconditions ?? null, JSON.stringify(input.steps), input.expected, row.seq + 1, charter?.code ?? null);
    this.logEvent(runId, null, 'scenario.add', { code, parent: input.parentCode ?? null, charter: charter?.code ?? null });
    return this.getScenario(runId, code);
  }

  /** Início da tentativa atual do cenário: o que veio antes (ex.: tentativa reaberta) não conta. */
  private attemptStart(scenarioId: number): string {
    const row = this.db.prepare('SELECT started_at FROM scenarios WHERE id = ?').get(scenarioId) as { started_at: string | null };
    return row.started_at ?? '';
  }

  completionFacts(scenario: ScenarioRow): CompletionFacts {
    const since = this.attemptStart(scenario.id);
    const verifications = this.db
      .prepare('SELECT kind, description, passed FROM verifications WHERE scenario_id = ? AND ts >= ? ORDER BY id')
      .all(scenario.id, since) as { kind: VerificationKind; description: string; passed: number }[];
    const count = (sql: string, ...params: (string | number)[]) =>
      (this.db.prepare(sql).get(scenario.id, since, ...params) as { n: number }).n;
    const events = (type: string) => count('SELECT COUNT(*) AS n FROM events WHERE scenario_id = ? AND ts >= ? AND type = ?', type);

    // Reprodução objetiva: a mesma checagem refeita e reprovada de novo.
    const failedByKey = new Map<string, number>();
    for (const v of verifications) {
      if (v.passed === 1) continue;
      const key = `${v.kind}|${v.description}`;
      failedByKey.set(key, (failedByKey.get(key) ?? 0) + 1);
    }
    const repeatedFailures = Math.max(0, ...[...failedByKey.values()].map((n) => n - 1));

    return {
      currentStatus: scenario.status,
      priority: scenario.priority,
      verifications: verifications.map((v) => ({ kind: v.kind, description: v.description, passed: v.passed === 1 })),
      evidenceCount: count('SELECT COUNT(*) AS n FROM evidence WHERE scenario_id = ? AND ts >= ?'),
      wroteData: count(`SELECT COUNT(*) AS n FROM actions WHERE scenario_id = ? AND ts >= ? AND ok = 1 AND guard_level IN ('YELLOW','RED')`) > 0,
      investigation: {
        network: events('inspect.network') > 0,
        console: events('inspect.console') > 0,
        api: events('inspect.api') > 0,
        reproductions: repeatedFailures,
      },
      consoleErrors: events('console.error'),
    };
  }

  completeScenario(runId: string, code: string, req: CompletionRequest) {
    this.requireExecuting(runId);
    const scenario = this.getScenario(runId, code);
    const result = evaluateCompletion(req, this.completionFacts(scenario));
    if (!result.ok) throw new StateError(`${code} não pode ser ${req.status}:\n- ${result.problems.join('\n- ')}`);

    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE scenarios SET status = ?, classification = ?, observed = ?, reason = ?,
             confidence = ?, confidence_score = ?, ended_at = ? WHERE id = ?`,
        )
        .run(req.status, req.classification ?? null, req.observed ?? null, req.reason ?? null,
          result.confidence, result.score, this.ts(), scenario.id);
      this.db.prepare('UPDATE runs SET current_scenario = NULL WHERE id = ? AND current_scenario = ?').run(runId, code);
      this.logEvent(runId, scenario.id, 'scenario.complete', { status: req.status, confidence: result.confidence });
    });
    const status = this.runStatus(runId);
    return { code, status: req.status as FinalStatus, confidence: result.confidence, notes: result.notes, progress: status.progress, next: status.next };
  }

  // ── Registros produzidos pelas ferramentas (não expostos ao Claude) ─

  recordVerification(runId: string, code: string, v: {
    kind: VerificationKind; description: string; expected?: string; actual?: string; passed: boolean; evidenceId?: number;
    /** Parâmetros da verificação (alvo, condição…), para virar assertion na automação. */
    spec?: unknown;
  }): number {
    const s = this.getScenario(runId, code);
    const result = this.db
      .prepare(
        `INSERT INTO verifications (run_id, scenario_id, kind, description, expected, actual, passed, evidence_id, ts, spec_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, s.id, v.kind, v.description, v.expected ?? null, v.actual ?? null, v.passed ? 1 : 0, v.evidenceId ?? null, this.ts(),
        v.spec === undefined ? null : JSON.stringify(v.spec));
    return Number(result.lastInsertRowid);
  }

  recordEvidence(runId: string, code: string | null, e: { kind: string; path?: string; sha256?: string; meta?: unknown }): number {
    const scenarioId = code ? this.getScenario(runId, code).id : null;
    const result = this.db
      .prepare(`INSERT INTO evidence (run_id, scenario_id, kind, path, sha256, sanitized, meta, ts) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(runId, scenarioId, e.kind, e.path ?? null, e.sha256 ?? null, e.meta === undefined ? null : JSON.stringify(e.meta), this.ts());
    return Number(result.lastInsertRowid);
  }

  recordAction(runId: string, code: string | null, a: {
    action: string; target?: unknown; valueRef?: string; guardLevel: 'GREEN' | 'YELLOW' | 'RED'; ok: boolean;
    error?: string; url?: string; durationMs?: number;
    /** Só valor literal (nunca de valueRef/segredo): massa de exemplo para a automação. */
    valueSample?: string;
  }): number {
    const scenarioId = code ? this.getScenario(runId, code).id : null;
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM actions WHERE run_id = ?').get(runId) as { n: number }).n;
    const result = this.db
      .prepare(
        `INSERT INTO actions (run_id, scenario_id, seq, action, target_json, value_ref, guard_level, ok, error, url, duration_ms, ts, value_sample)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, scenarioId, seq, a.action, a.target === undefined ? null : JSON.stringify(a.target), a.valueRef ?? null,
        a.guardLevel, a.ok ? 1 : 0, a.error ?? null, a.url ?? null, a.durationMs ?? null, this.ts(), a.valueSample?.slice(0, 200) ?? null);
    return Number(result.lastInsertRowid);
  }

  recordApproval(runId: string, a: { action: string; target: string; level: string; justification: string }): number {
    const result = this.db
      .prepare(`INSERT INTO approvals (run_id, action, target, level, decision, ts, agent) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, a.action, a.target, a.level, `APPROVED: ${a.justification}`, this.ts(), this.agentJson());
    return Number(result.lastInsertRowid);
  }

  // ── Dados criados e limpeza ──────────────────────────────────────────

  /** Criação detectada automaticamente (POST 2xx disparado por ação YELLOW/RED). */
  addCreatedCandidate(runId: string, code: string | null, resource: string, extId: string | undefined): number {
    const scenarioId = code ? this.getScenario(runId, code).id : null;
    const result = this.db
      .prepare(`INSERT INTO created_data (run_id, scenario_id, resource, ext_id, cleanup_status, ts) VALUES (?, ?, ?, ?, 'UNREGISTERED', ?)`)
      .run(runId, scenarioId, resource, extId ?? null, this.ts());
    this.logEvent(runId, scenarioId, 'data.detected', { resource, extId: extId ?? null });
    return Number(result.lastInsertRowid);
  }

  /** Registra (ou completa um candidato detectado com) o plano de limpeza. */
  registerCreatedData(runId: string, input: { id?: number; resource?: string; extId?: string; cleanup: CleanupSpec }): CreatedDataRow {
    this.getRun(runId);
    const status: CleanupStatus = input.cleanup.method === 'keep' ? 'KEPT' : 'PENDING';
    let id = input.id;
    if (id !== undefined) {
      const row = this.getCreatedData(runId, id);
      if (row.cleanup_status === 'VERIFIED') throw new StateError(`#${id} já foi limpo e verificado`);
      // Desistir da limpeza depois de ela falhar não pode ser silencioso: o motivo diz por que falhou.
      if (row.cleanup_status === 'FAILED' && input.cleanup.method === 'keep') {
        if (!/falh/i.test(input.cleanup.reason) || input.cleanup.reason.trim().length < 30) {
          throw new StateError(`#${id}: a limpeza falhou; keep exige motivo explicando a falha e quem resolve (ex.: "limpeza falhou: API devolve 500; dev remove pelo banco")`);
        }
        this.logEvent(runId, row.scenario_id, 'data.keep_after_failure', { id, resource: row.resource, reason: input.cleanup.reason });
      }
      if (input.cleanup.method === 'api') {
        // A requisição de limpeza só pode mirar o próprio dado: o id dele, ou o recurso detectado.
        const extId = input.extId ?? row.ext_id;
        const path = input.cleanup.request.path;
        const resourcePath = row.resource.replace(/^[A-Z]+ /, '').split('?')[0]!;
        if (extId ? !path.split('?')[0]!.split('/').includes(extId) : !path.startsWith(resourcePath)) {
          throw new StateError(extId
            ? `limpeza de #${id}: o caminho precisa conter o id do dado criado (${extId})`
            : `limpeza de #${id}: o caminho precisa começar pelo recurso detectado (${resourcePath})`);
        }
      }
      this.db
        .prepare('UPDATE created_data SET cleanup_json = ?, cleanup_status = ?, ext_id = COALESCE(?, ext_id) WHERE id = ?')
        .run(JSON.stringify(input.cleanup), status, input.extId ?? null, id);
    } else {
      if (!input.resource) throw new StateError('informe id (candidato detectado) ou resource');
      if (input.cleanup.method === 'api') {
        throw new StateError('limpeza via API só para dados detectados pelo act (use o id do candidato); dado registrado à mão: manual (desfeito pela UI) ou keep');
      }
      const code = this.getRun(runId).current_scenario;
      const scenarioId = code ? this.getScenario(runId, code).id : null;
      id = Number(
        this.db
          .prepare(`INSERT INTO created_data (run_id, scenario_id, resource, ext_id, cleanup_json, cleanup_status, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(runId, scenarioId, input.resource, input.extId ?? null, JSON.stringify(input.cleanup), status, this.ts()).lastInsertRowid,
      );
    }
    this.logEvent(runId, null, 'data.register', { id, method: input.cleanup.method });
    return this.getCreatedData(runId, id);
  }

  getCreatedData(runId: string, id: number): CreatedDataRow {
    const row = this.db.prepare('SELECT * FROM created_data WHERE run_id = ? AND id = ?').get(runId, id) as CreatedDataRow | undefined;
    if (!row) throw new StateError(`dado criado #${id} não existe no run ${runId}`);
    return row;
  }

  listCreatedData(runId: string): CreatedDataRow[] {
    return this.db.prepare('SELECT * FROM created_data WHERE run_id = ? ORDER BY id').all(runId) as unknown as CreatedDataRow[];
  }

  setCleanupStatus(runId: string, id: number, status: 'VERIFIED' | 'FAILED', note: string): void {
    this.db
      .prepare('UPDATE created_data SET cleanup_status = ?, verified_at = ? WHERE run_id = ? AND id = ?')
      .run(status, status === 'VERIFIED' ? this.ts() : null, runId, id);
    this.logEvent(runId, null, `cleanup.${status.toLowerCase()}`, { id, note });
  }

  /**
   * Ações bem-sucedidas seguidas de verificação aprovada (ARCHITECTURE.md D1): no mesmo cenário,
   * ou — para ações de setup fora de cenário, como login — em qualquer cenário depois delas.
   */
  validatedActions(runId: string): ValidatedActionRow[] {
    return this.db
      .prepare(
        `SELECT a.action, a.target_json, a.value_ref, a.url, a.ts, COALESCE(s.code, '(setup)') AS scenario
         FROM actions a LEFT JOIN scenarios s ON s.id = a.scenario_id
         WHERE a.run_id = ? AND a.ok = 1
           AND EXISTS (SELECT 1 FROM verifications v
                       WHERE v.passed = 1 AND v.ts >= a.ts
                         AND (v.scenario_id = a.scenario_id OR (a.scenario_id IS NULL AND v.run_id = a.run_id)))
         ORDER BY a.seq`,
      )
      .all(runId) as unknown as ValidatedActionRow[];
  }

  // ── Perguntas ao usuário (modo descoberta) ──────────────────────────

  /** Registra o que não dá para deduzir do sistema. Só antes da aprovação do plano: é o que decide o plano. */
  askQuestions(runId: string, questions: { module: string; text: string; options?: string[]; about?: string }[]): QuestionRow[] {
    const run = this.getRun(runId);
    if (!ACTIVE_RUN.includes(run.status)) throw new StateError(`run está ${run.status}`);
    const known = new Set(this.listQuestions(runId).map((q) => q.text.trim().toLowerCase()));
    const ts = this.ts();
    for (const q of questions) {
      if (known.has(q.text.trim().toLowerCase())) continue;
      this.db.prepare(`INSERT INTO questions (project, run_id, module, text, options, about, status, asked_at) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)`)
        .run(run.project, runId, q.module, q.text.trim(), q.options?.length ? JSON.stringify(q.options) : null, q.about ?? null, ts);
    }
    this.logEvent(runId, null, 'question.ask', { count: questions.length });
    return this.listQuestions(runId);
  }

  listQuestions(runId: string): QuestionRow[] {
    const rows = this.db.prepare(`SELECT * FROM questions WHERE run_id = ? ORDER BY id`).all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id), project: String(r.project), module: String(r.module), text: String(r.text),
      options: r.options ? (JSON.parse(String(r.options)) as string[]) : [], about: (r.about as string | null) ?? null,
      status: r.status as QuestionRow['status'], answer: (r.answer as string | null) ?? null,
      askedAt: String(r.asked_at), answeredAt: (r.answered_at as string | null) ?? null,
    }));
  }

  /** Resposta do usuário (ou dispensa com motivo). Quem chama grava a regra; aqui fica o registro. */
  answerQuestion(runId: string, id: number, input: { answer?: string; dismiss?: string }): QuestionRow {
    const q = this.listQuestions(runId).find((x) => x.id === id);
    if (!q) throw new StateError(`pergunta ${id} não existe neste run`);
    if (q.status !== 'OPEN') throw new StateError(`pergunta ${id} já está ${q.status}`);
    const text = (input.answer ?? input.dismiss ?? '').trim();
    if (text.length < 2) throw new StateError('informe answer (o que o usuário respondeu) ou dismiss (por que não será respondida agora)');
    const status = input.answer ? 'ANSWERED' : 'DISMISSED';
    this.db.prepare(`UPDATE questions SET status = ?, answer = ?, answered_at = ? WHERE id = ?`).run(status, text, this.ts(), id);
    this.logEvent(runId, null, 'question.answer', { id, status });
    return this.listQuestions(runId).find((x) => x.id === id)!;
  }

  logEvent(runId: string | null, scenarioId: number | null, type: string, payload: unknown): number {
    return Number(this.db
      .prepare('INSERT INTO events (run_id, scenario_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)')
      .run(runId, scenarioId, type, payload === null || payload === undefined ? null : JSON.stringify(payload), this.ts()).lastInsertRowid);
  }

  /** Completa o evento de uma chamada de ferramenta com o desfecho (ok/erro, duração). */
  finishEvent(id: number, payload: unknown): void {
    this.db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id);
  }
}

export type { Classification, CompletionRequest };
