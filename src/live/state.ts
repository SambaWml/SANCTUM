import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DigestCache } from '../sources/digest.ts';
import { planCoverage } from '../state/coverage.ts';
import type { Db } from '../state/db.ts';

/**
 * Estado do painel do Sanctum, montado só por leitura do banco: nenhum token,
 * nenhuma escrita. O painel mostra o que os agentes estão fazendo; quem decide continua sendo o
 * terminal (aprovações seguem pelo Claude Code).
 */

export type AgentKind = 'claude' | 'antigravity' | 'codex' | 'other';
export type FeedClass = '' | 'ok' | 'bad' | 'warn' | 'ask' | 'info' | 'muted';

export interface FeedLine { ts: string; text: string; cls: FeedClass; runId: string; agent: AgentKind }
export interface LiveScenario {
  code: string; title: string; priority: string; status: string; classification: string | null;
  preconditions?: string | null; steps?: string[]; expected?: string; observed?: string | null;
}
export interface LiveBug {
  code: string; title: string; jira?: string; runId: string; card: string; ts: string;
  screenshot?: string | null; priority?: string | null;
}
export interface Pending {
  runId: string; card: string; agent: AgentKind; kind: 'plan' | 'red'; title: string; detail: string; ts: string; scenarios?: LiveScenario[];
  /** Plano: critérios do card sem nenhum cenário (para o usuário ver antes de aprovar). */
  uncovered?: string[];
}

export interface LiveRun {
  id: string; card: string; mode: string; env: string; status: string; agent: AgentKind; agentLabel: string;
  startedAt: string; endedAt: string | null;
  /** 0 entender · 1 plano · 2 ordem · 3 caçar · 4 faxina · 5 relatório */
  phase: number; waiting: boolean;
  /** Run ativo sem nenhuma atividade há N minutos (ninguém operando); null se encerrado. */
  idleMinutes: number | null;
  recommendation: string | null; ceilingReasons: string[];
  scenarios: LiveScenario[]; current: string | null; nowLine: string; feed: FeedLine[];
  bugs: LiveBug[]; summaries: { code: string; verdict: string; text: string; jira?: string }[];
  data: { total: number; pending: number; verified: number; kept: number; failed: number }; mutations: number;
  decisions: { ts: string; text: string }[];
  video: { id: number; chapters: { code: string; atSec: number }[] } | null;
  shots: { id: number; code: string | null; name: string }[];
  lastShot: number | null; report: boolean;
  /** Sessão exploratória aberta e as planejadas que faltam. */
  charter: { code: string; target: string; minutesLeft: number; pending: number } | null;
  evidenceDir: string; reportPath: string;
}


export interface LiveState {
  generatedAt: string;
  stats: { missionsToday: number; bugsToday: number; scenariosToday: number };
  runs: LiveRun[]; pending: Pending[]; bugs: LiveBug[]; timeline: FeedLine[];
}

const ACTIVE = ['PLANNING', 'AWAITING_APPROVAL', 'EXECUTING'];
const DONE = ['PASSED', 'FAILED', 'BLOCKED', 'NOT_EXECUTED', 'NEEDS_REVIEW'];
const LABEL: Record<AgentKind, string> = { claude: 'Claude', antigravity: 'Antigravity', codex: 'Codex', other: 'Sem registro' };
// 'Sem registro': runs de antes de 02/11, quando o run ainda não gravava qual agente o executou.
export const VERB: Record<string, string> = {
  click: 'clicou em', fill: 'preencheu', press: 'teclou em', select: 'escolheu em', check: 'marcou', uncheck: 'desmarcou',
  hover: 'passou o mouse em', upload: 'enviou arquivo em', dblclick: 'clicou duas vezes em',
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const parse = <T>(v: unknown, fallback: T): T => { try { return v ? (JSON.parse(String(v)) as T) : fallback; } catch { return fallback; } };

export function agentKind(agentJson: unknown): AgentKind {
  const client = str(parse<{ client?: string }>(agentJson, {}).client).toLowerCase();
  if (client.includes('antigravity')) return 'antigravity';
  if (client.includes('codex')) return 'codex';
  if (client.includes('claude')) return 'claude';
  return 'other';
}

export function targetName(targetJson: unknown): string {
  const t = parse<Record<string, unknown>>(targetJson, {});
  const name = str(t.name ?? t.label ?? t.placeholder ?? t.text ?? t.testId ?? t.role);
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

export interface BuildOptions { rootDir: string; now?: Date; feedSize?: number; maxRuns?: number }

export function buildLiveState(db: Db, opts: BuildOptions): LiveState {
  const now = opts.now ?? new Date();
  const all = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Row[];
  const get = (sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as Row | undefined;

  // Runs ativos e os encerrados nas últimas 12 h (o painel é do dia, não um histórico), menos os ocultados.
  const since = new Date(now.getTime() - 12 * 3600_000).toISOString();
  let runRows = all(
    `SELECT * FROM runs WHERE (status IN ('PLANNING','AWAITING_APPROVAL','EXECUTING') OR COALESCE(ended_at, started_at) >= ?)
       AND id NOT IN (SELECT run_id FROM hidden_runs)
     ORDER BY CASE WHEN status IN ('PLANNING','AWAITING_APPROVAL','EXECUTING') THEN 0 ELSE 1 END, started_at DESC LIMIT ?`,
    since, opts.maxRuns ?? 6);
  if (!runRows.length) runRows = all(`SELECT * FROM runs WHERE id NOT IN (SELECT run_id FROM hidden_runs) ORDER BY started_at DESC LIMIT 1`);

  const runs = runRows.map((r) => buildRun(r, all, get, opts));
  const pending = runs.flatMap((r) => pendingOf(r, runRows.find((x) => x.id === r.id)!, get));
  const cache = new DigestCache(db, opts.rootDir);
  for (const p of pending.filter((x) => x.kind === 'plan')) {
    const hit = cache.get('jira', p.card, undefined, { internal: true });
    const criteria = hit.hit ? ((hit.digest as { acceptanceCriteria?: string[] }).acceptanceCriteria ?? []) : [];
    if (criteria.length) {
      const scenarios = all('SELECT code, title, expected FROM scenarios WHERE run_id = ?', p.runId).map((s) => ({ code: str(s.code), title: str(s.title), expected: str(s.expected) }));
      p.uncovered = planCoverage(criteria, scenarios).uncovered;
    }
  }

  // "Hoje" é o dia local de quem usa o painel (em UTC, às 21h do Brasil tudo zerava).
  const today = startOfLocalDay(now).toISOString();
  const bugsAll = explainedBugs(all, `ts >= ?`, new Date(now.getTime() - 7 * 86400_000).toISOString());
  const confirmed = confirmedBugs(all);
  const timeline = runs.flatMap((r) => r.feed.filter((f) => f.cls !== '' || /iniciado|PASSED|FAILED|BLOCKED/.test(f.text)))
    .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 80);

  return {
    generatedAt: now.toISOString(),
    stats: {
      missionsToday: Number(get(`SELECT COUNT(*) n FROM runs WHERE started_at >= ?`, today)?.n ?? 0),
      bugsToday: [...confirmed.values()].filter((b) => b.ts >= today).length,
      scenariosToday: Number(get(`SELECT COUNT(*) n FROM scenarios WHERE ended_at >= ? AND status IN ('PASSED','FAILED','BLOCKED','NEEDS_REVIEW')`, today)?.n ?? 0),
    },
    runs, pending, bugs: bugsAll.slice(0, 36), timeline,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const prevDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);

export interface ConfirmedBug { agent: AgentKind; ts: string; exploratory: boolean }

/**
 * Bug confirmado: cenário classificado PRODUCT_BUG (o core exige reprodução) ou problema que virou
 * card no Jira. Contado uma vez por run+cenário — chamar report_build de novo não soma nada.
 */
export function confirmedBugs(all: (sql: string, ...a: (string | number)[]) => Row[]): Map<string, ConfirmedBug> {
  const out = new Map<string, ConfirmedBug>();
  const agentOf = new Map(all(`SELECT id, agent FROM runs`).map((r) => [str(r.id), agentKind(r.agent)]));
  for (const s of all(`SELECT run_id, code, COALESCE(ended_at, started_at) ts FROM scenarios WHERE classification = 'PRODUCT_BUG'`)) {
    out.set(`${str(s.run_id)}:${str(s.code)}`, { agent: agentOf.get(str(s.run_id)) ?? 'other', ts: str(s.ts), exploratory: str(s.code).startsWith('EXP-') });
  }
  for (const e of all(`SELECT run_id, payload, ts FROM events WHERE type IN ('report.explain','report.summaries') AND payload LIKE '%"jira"%'`)) {
    for (const x of parse<{ code: string; jira?: string }[]>(e.payload, [])) {
      const key = `${str(e.run_id)}:${x.code}`;
      if (x.jira && !out.has(key)) out.set(key, { agent: agentOf.get(str(e.run_id)) ?? 'other', ts: str(e.ts), exploratory: x.code.startsWith('EXP-') });
    }
  }
  return out;
}

export function buildRun(r: Row, all: (sql: string, ...a: (string | number)[]) => Row[], get: (sql: string, ...a: (string | number)[]) => Row | undefined, opts: BuildOptions): LiveRun {
  const id = str(r.id);
  const agent = agentKind(r.agent);
  const scenarios = all(`SELECT id, code, title, priority, status, classification, preconditions, steps, expected, observed FROM scenarios WHERE run_id = ? ORDER BY seq`, id);
  const codeOf = new Map(scenarios.map((s) => [Number(s.id), str(s.code)]));
  const sc = (sid: unknown) => (sid === null || sid === undefined ? '' : `${codeOf.get(Number(sid)) ?? ''} `);

  // Atividade: ações, verificações e eventos de negócio (as chamadas tool.* e inspect.* são ruído).
  const lines: FeedLine[] = [];
  const push = (ts: unknown, text: string, cls: FeedClass = '') => lines.push({ ts: str(ts), text, cls, runId: id, agent });
  for (const a of all(`SELECT * FROM actions WHERE run_id = ? ORDER BY id DESC LIMIT 60`, id)) {
    const verb = VERB[str(a.action)] ?? str(a.action);
    const sample = a.value_sample ? ` = "${str(a.value_sample).slice(0, 40)}"` : '';
    const level = a.guard_level !== 'GREEN' ? ` [${str(a.guard_level)}]` : '';
    if (Number(a.ok)) push(a.ts, `${sc(a.scenario_id)}${verb} "${targetName(a.target_json)}"${sample}${level}`, a.guard_level === 'RED' ? 'warn' : '');
    else push(a.ts, `${sc(a.scenario_id)}${verb} "${targetName(a.target_json)}"${level} — ${str(a.error).slice(0, 120)}`, str(a.error).startsWith('BLOQUEADO') ? 'ask' : 'bad');
  }
  for (const v of all(`SELECT * FROM verifications WHERE run_id = ? ORDER BY id DESC LIMIT 60`, id)) {
    push(v.ts, `${sc(v.scenario_id)}${Number(v.passed) ? '✓' : '✗'} ${str(v.description)}`, Number(v.passed) ? 'ok' : 'bad');
  }
  for (const e of all(`SELECT * FROM events WHERE run_id = ? AND type NOT LIKE 'tool.%' AND type NOT LIKE 'inspect.%'
                       AND type NOT IN ('console.error','cache.hit','cache.miss','cache.stale','batch.brief','context.build','report.explain','report.summaries','report.explain_remove')
                       ORDER BY id DESC LIMIT 80`, id)) {
    const p = parse<Record<string, unknown>>(e.payload, {});
    const code = sc(e.scenario_id).trim();
    switch (str(e.type)) {
      case 'run.start': push(e.ts, `missão iniciada (${str(p.mode)} em ${str(p.env)})`, 'info'); break;
      case 'plan.save': push(e.ts, `plano salvo com ${str(p.count)} cenário(s)`, 'info'); break;
      case 'plan.approve': push(e.ts, 'plano aprovado — começou a caçada', 'ok'); break;
      case 'scenario.start': push(e.ts, `${code} iniciado`, 'info'); break;
      case 'scenario.complete': {
        const s = str(p.status);
        push(e.ts, `${code} ${s}`, s === 'PASSED' ? 'ok' : s === 'FAILED' ? 'bad' : s === 'BLOCKED' ? 'muted' : 'warn');
        break;
      }
      case 'scenario.reopen': push(e.ts, `${code} reaberto: ${str(p.reason).slice(0, 100)}`, 'warn'); break;
      case 'scenario.loop': push(e.ts, `${code} andando em círculo: ${str(p.actions)} ações e ${str(p.verifications)} verificações${p.level === 'stop' ? ' — travado pelo Sanctum' : ''}`, 'bad'); break;
      case 'scenario.reclassify': push(e.ts, `${code} reclassificado ${str(p.from)} → ${str(p.to)}`, 'warn'); break;
      case 'scenario.add': push(e.ts, `achou caminho novo: ${str(p.code)}${p.charter ? ` (sessão ${str(p.charter)})` : ''}`, 'info'); break;
      case 'charter.start': push(e.ts, `abriu a sessão exploratória ${str(p.code)}`, 'info'); break;
      case 'charter.end': push(e.ts, `fechou a sessão ${str(p.code)}: ${str(p.minutes)} min, ${str(p.findings)} achado(s)`, 'ok'); break;
      case 'charter.skip': push(e.ts, `pulou a sessão ${str(p.code)}: ${str(p.reason).slice(0, 100)}`, 'warn'); break;
      case 'guard.block': push(e.ts, `${code ? `${code} ` : ''}guard ${str(p.level)}: ${str(p.reason)}${p.needsApproval ? ' — precisa de você' : ''}`, 'ask'); break;
      case 'guard.mutation': push(e.ts, `${code ? `${code} ` : ''}alteração de dados percebida pela rede`, 'warn'); break;
      case 'data.register': push(e.ts, `${code ? `${code} ` : ''}dado criado registrado para limpeza`, 'info'); break;
      case 'data.detected': push(e.ts, `${code ? `${code} ` : ''}dado criado detectado`, 'info'); break;
      case 'cleanup.verified': push(e.ts, 'limpeza verificada', 'ok'); break;
      case 'cleanup.failed': push(e.ts, 'limpeza falhou', 'bad'); break;
      case 'http.error': push(e.ts, `${code ? `${code} ` : ''}API respondeu erro ${str(p.status)} ${str(p.method)} ${str(p.path ?? p.url).slice(0, 80)}`.trim(), 'bad'); break;
      case 'browser.open': push(e.ts, 'abriu o navegador', 'muted'); break;
      case 'network.simulate': push(e.ts, `${code ? `${code} ` : ''}simulou falha de rede`, 'warn'); break;
      case 'run.complete': push(e.ts, `missão concluída: ${p.recommendation ? str(p.recommendation) : 'exploração'}`, p.recommendation === 'APROVADO' ? 'ok' : p.recommendation === 'REPROVADO' ? 'bad' : 'warn'); break;
      case 'run.abort': push(e.ts, `missão abortada: ${str(p.reason).slice(0, 100)}`, 'bad'); break;
      case 'run.recommendation_lowered': push(e.ts, `recomendação rebaixada para ${str(p.to)}`, 'warn'); break;
      default: break;
    }
  }
  const feed = lines.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-(opts.feedSize ?? 40));

  const status = str(r.status);
  const done = scenarios.filter((s) => DONE.includes(str(s.status))).length;
  const data = all(`SELECT cleanup_status FROM created_data WHERE run_id = ?`, id).map((d) => str(d.cleanup_status));
  const pendingData = data.filter((d) => d === 'PENDING' || d === 'UNREGISTERED').length;
  const planSaved = Boolean(get(`SELECT 1 FROM events WHERE run_id = ? AND type = 'plan.save'`, id));
  const phase = status === 'PLANNING' ? (planSaved ? 1 : 0) : status === 'AWAITING_APPROVAL' ? 2
    : status === 'EXECUTING' ? (scenarios.length && done === scenarios.length ? 4 : 3) : 5;

  const current = scenarios.find((s) => s.status === 'IN_PROGRESS');
  const last = feed[feed.length - 1];
  const complete = get(`SELECT payload FROM events WHERE run_id = ? AND type = 'run.complete' ORDER BY id DESC LIMIT 1`, id);

  const explained = new Map<string, { title: string; jira?: string }>();
  for (const e of all(`SELECT type, payload FROM events WHERE run_id = ? AND type IN ('report.explain','report.explain_remove') ORDER BY id`, id)) {
    if (e.type === 'report.explain_remove') for (const c of parse<string[]>(e.payload, [])) explained.delete(c);
    else for (const x of parse<{ code: string; title: string; jira?: string }[]>(e.payload, [])) explained.set(x.code, x);
  }
  const summaries = new Map<string, { code: string; verdict: string; text: string; jira?: string }>();
  for (const e of all(`SELECT payload FROM events WHERE run_id = ? AND type = 'report.summaries' ORDER BY id`, id)) {
    for (const x of parse<{ code: string; verdict: string; text: string; jira?: string }[]>(e.payload, [])) summaries.set(x.code, x);
  }
  const bugs = [...explained.values()].map((x) => ({
    code: (x as { code?: string }).code ?? '', title: x.title, jira: x.jira ?? summaries.get((x as { code?: string }).code ?? '')?.jira,
    runId: id, card: str(r.issue_key), ts: str(r.ended_at ?? r.started_at),
  }));

  const evidence = all(`SELECT id, scenario_id, kind, path, meta FROM evidence WHERE run_id = ? ORDER BY id`, id);
  const sessionVideos = evidence.filter((e) => e.kind === 'video' && e.scenario_id === null && str(e.path).endsWith('.webm'));
  const videosWithChapters = sessionVideos.filter((v) => {
    const ch = parse<{ chapters?: unknown[] }>(v.meta, {}).chapters;
    return Array.isArray(ch) && ch.length > 0;
  });
  const repVideo = videosWithChapters[videosWithChapters.length - 1] ?? (sessionVideos.length ? sessionVideos[sessionVideos.length - 1] : null);
  const chapters: { code: string; atSec: number }[] = repVideo
    ? (parse<{ chapters?: { code: string; atSec: number }[] }>(repVideo.meta, {}).chapters ?? [])
    : [];
  const pngs = evidence.filter((e) => str(e.path).toLowerCase().endsWith('.png'));
  const failedCodes = new Set(scenarios.filter((s) => s.status === 'FAILED').map((s) => str(s.code)));

  return {
    id, card: str(r.issue_key), mode: str(r.mode), env: str(r.env), status, agent, agentLabel: LABEL[agent],
    startedAt: str(r.started_at), endedAt: r.ended_at ? str(r.ended_at) : null,
    phase, waiting: status === 'AWAITING_APPROVAL',
    idleMinutes: ACTIVE.includes(status)
      ? Math.max(0, Math.floor(((opts.now ?? new Date()).getTime() - Date.parse(last?.ts || str(r.started_at))) / 60_000)) : null,
    recommendation: r.recommendation ? str(r.recommendation) : null,
    ceilingReasons: parse<{ reasons?: string[] }>(complete?.payload, {}).reasons ?? [],
    scenarios: scenarios.map((s) => ({
      code: str(s.code), title: str(s.title), priority: str(s.priority), status: str(s.status), classification: s.classification ? str(s.classification) : null,
      preconditions: s.preconditions ? str(s.preconditions) : null,
      steps: parse<string[]>(s.steps, []),
      expected: str(s.expected),
      observed: s.observed ? str(s.observed) : null,
    })),
    current: current ? str(current.code) : null,
    nowLine: ACTIVE.includes(status) ? (last?.text ?? 'preparando…') : status === 'ABORTED' ? 'missão abortada' : 'missão encerrada',
    feed, bugs, summaries: [...summaries.values()],
    data: { total: data.length, pending: pendingData, verified: data.filter((d) => d === 'VERIFIED').length, kept: data.filter((d) => d === 'KEPT').length, failed: data.filter((d) => d === 'FAILED').length },
    mutations: Number(get(`SELECT COUNT(*) n FROM events WHERE run_id = ? AND type = 'guard.mutation'`, id)?.n ?? 0),
    decisions: all(`SELECT action, target, level, ts FROM approvals WHERE run_id = ? ORDER BY id`, id).map((a) => ({
      ts: str(a.ts),
      text: a.level === 'PLAN' ? `Aprovou o plano (${scenarios.length} cenários)`
        : `Autorizou ${str(a.level)}: ${VERB[str(a.action)] ?? str(a.action)} ${str(a.target).slice(0, 80)}`,
    })),
    video: repVideo ? { id: Number(repVideo.id), chapters } : null,
    shots: pngs.filter((p) => failedCodes.has(codeOf.get(Number(p.scenario_id)) ?? '')).slice(-6)
      .map((p) => ({ id: Number(p.id), code: codeOf.get(Number(p.scenario_id)) ?? null, name: str(p.path).split(/[\\/]/).pop() ?? '' })),
    lastShot: pngs.length ? Number(pngs[pngs.length - 1]!.id) : null,
    charter: (() => {
      const rows = all(`SELECT code, target, timebox_min, started_at, status FROM charters WHERE run_id = ? AND status IN ('OPEN','PLANNED') ORDER BY code`, id);
      const open = rows.find((c) => c.status === 'OPEN');
      if (!open || !ACTIVE.includes(status)) return null;
      const elapsed = ((opts.now ?? new Date()).getTime() - Date.parse(str(open.started_at))) / 60_000;
      return { code: str(open.code), target: str(open.target), minutesLeft: Math.round(Number(open.timebox_min) - elapsed), pending: rows.length - 1 };
    })(),
    report: existsSync(join(opts.rootDir, 'reports', str(r.issue_key), `${id}.html`)),
    evidenceDir: join(opts.rootDir, 'runs', str(r.issue_key), id, 'evidence'),
    reportPath: join(opts.rootDir, 'reports', str(r.issue_key), `${id}.html`),
  };
}

function pendingOf(run: LiveRun, r: Row, get: (sql: string, ...a: (string | number)[]) => Row | undefined): Pending[] {
  if (run.status === 'AWAITING_APPROVAL') {
    const ts = str(get(`SELECT ts FROM events WHERE run_id = ? AND type = 'plan.save' ORDER BY id DESC LIMIT 1`, run.id)?.ts ?? r.started_at);
    return [{ runId: run.id, card: run.card, agent: run.agent, kind: 'plan', title: `Plano de ${run.scenarios.length} cenário(s) aguardando aprovação`, detail: 'Aprove ou peça ajustes no terminal do agente.', ts, scenarios: run.scenarios }];
  }
  if (run.status !== 'EXECUTING') return [];
  // Ação RED bloqueada sem nada depois (nem aprovação, nem outra ação): o agente está esperando você.
  const block = get(`SELECT id, ts, payload FROM events WHERE run_id = ? AND type = 'guard.block' ORDER BY id DESC LIMIT 1`, run.id);
  if (!block || !parse<{ needsApproval?: boolean }>(block.payload, {}).needsApproval) return [];
  const later = get(`SELECT 1 FROM approvals WHERE run_id = ? AND ts > ? UNION SELECT 1 FROM actions WHERE run_id = ? AND ts > ? AND ok = 1`, run.id, str(block.ts), run.id, str(block.ts));
  if (later) return [];
  const action = get(`SELECT action, target_json FROM actions WHERE run_id = ? AND ok = 0 AND error LIKE 'BLOQUEADO%' ORDER BY id DESC LIMIT 1`, run.id);
  const what = action ? `${VERB[str(action.action)] ?? str(action.action)} "${targetName(action.target_json)}"` : 'ação de risco';
  return [{ runId: run.id, card: run.card, agent: run.agent, kind: 'red', title: `Ação de risco: ${what}`, detail: `${parse<{ reason?: string }>(block.payload, {}).reason ?? ''} — responda no terminal do agente.`, ts: str(block.ts) }];
}

function explainedBugs(all: (sql: string, ...a: (string | number)[]) => Row[], where: string, arg: string): LiveBug[] {
  const out = new Map<string, LiveBug>();
  for (const e of all(`SELECT e.run_id, e.type, e.payload, e.ts, r.issue_key FROM events e JOIN runs r ON r.id = e.run_id
                       WHERE e.type IN ('report.explain','report.explain_remove','report.summaries') AND e.${where} ORDER BY e.id`, arg)) {
    const runId = str(e.run_id);
    if (e.type === 'report.explain_remove') { for (const c of parse<string[]>(e.payload, [])) out.delete(`${runId}:${c}`); continue; }
    for (const x of parse<{ code: string; title?: string; jira?: string }[]>(e.payload, [])) {
      const key = `${runId}:${x.code}`;
      if (e.type === 'report.summaries') { const b = out.get(key); if (b && x.jira) b.jira = x.jira; continue; }
      out.set(key, { code: x.code, title: str(x.title), jira: x.jira ?? out.get(key)?.jira, runId, card: str(e.issue_key), ts: str(e.ts) });
    }
  }
  const result = [...out.values()];
  for (const b of result) {
    const sc = all(`SELECT priority, risk, title FROM scenarios WHERE run_id = ? AND code = ? LIMIT 1`, b.runId, b.code)[0] as { priority?: string; risk?: string; title?: string } | undefined;
    const prio = sc?.priority ? str(sc.priority) : 'P1';


    const ev = all(`SELECT path FROM evidence WHERE run_id = ? AND kind = 'screenshot' AND (scenario_id = (SELECT id FROM scenarios WHERE run_id = ? AND code = ?) OR path LIKE ?) ORDER BY id DESC LIMIT 1`, b.runId, b.runId, b.code, `%${b.code}%`)[0] as { path?: string } | undefined;
    b.screenshot = ev?.path ? `/${str(ev.path).replace(/\\/g, '/')}` : null;
  }
  return result.sort((a, b) => b.ts.localeCompare(a.ts));
}
