import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../state/db.ts';

/**
 * Estado do painel ao vivo ("Central de Caça"), montado só por leitura do banco: nenhum token,
 * nenhuma escrita. O painel mostra o que os agentes estão fazendo; quem decide continua sendo o
 * terminal (aprovações seguem pelo Claude Code).
 */

export type AgentKind = 'claude' | 'antigravity' | 'codex' | 'other';
export type FeedClass = '' | 'ok' | 'bad' | 'warn' | 'ask' | 'info' | 'muted';

export interface FeedLine { ts: string; text: string; cls: FeedClass; runId: string; agent: AgentKind }
export interface LiveScenario { code: string; title: string; priority: string; status: string; classification: string | null }
export interface LiveBug {
  code: string; title: string; jira?: string; runId: string; card: string; ts: string;
  screenshot?: string | null; priority?: string | null; rarity?: 'common' | 'rare' | 'epic' | 'legendary';
}
export interface Pending { runId: string; card: string; agent: AgentKind; kind: 'plan' | 'red'; title: string; detail: string; ts: string; scenarios?: LiveScenario[] }

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
}

export interface AgentScore { agent: AgentKind; label: string; xp: number; level: number; title: string; next: number; base: number }
export interface Badge { id: string; icon: string; name: string; hint: string; unlocked: boolean; tier?: 'bronze' | 'prata' | 'ouro' | 'lendario'; progress?: string }

export interface LiveState {
  generatedAt: string;
  stats: { missionsToday: number; bugsToday: number; scenariosToday: number; streakDays: number; shieldPct?: number };
  runs: LiveRun[]; pending: Pending[]; bugs: LiveBug[]; timeline: FeedLine[];
  agents: AgentScore[]; badges: Badge[];
}

const ACTIVE = ['PLANNING', 'AWAITING_APPROVAL', 'EXECUTING'];
const DONE = ['PASSED', 'FAILED', 'BLOCKED', 'NOT_EXECUTED', 'NEEDS_REVIEW'];
const LABEL: Record<AgentKind, string> = { claude: 'Claude', antigravity: 'Antigravity', codex: 'Codex', other: 'Agente' };
const TITLES = ['Aprendiz da Ordem', 'Escudeiro de Ferro', 'Caçador de Catacumbas', 'Cavaleiro Purificador', 'Mestre das Sombras', 'Lenda Ancestral'];
const VERB: Record<string, string> = {
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

function targetName(targetJson: unknown): string {
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

  const today = now.toISOString().slice(0, 10);
  const bugsAll = explainedBugs(all, `ts >= ?`, new Date(now.getTime() - 7 * 86400_000).toISOString());
  const timeline = runs.flatMap((r) => r.feed.filter((f) => f.cls !== '' || /iniciado|PASSED|FAILED|BLOCKED/.test(f.text)))
    .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 80);

  const days = new Set(all(`SELECT DISTINCT substr(started_at, 1, 10) d FROM runs`).map((r) => str(r.d)));
  // Sequência de dias com missão; o dia de hoje ainda sem missão não quebra a sequência.
  let streak = 0;
  let d = new Date(`${today}T12:00:00Z`);
  if (!days.has(today)) d = new Date(d.getTime() - 86400_000);
  for (; days.has(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 86400_000)) streak++;

  const passedTotal = Number(get(`SELECT COUNT(*) n FROM scenarios WHERE status = 'PASSED'`)?.n ?? 0);
  const allTotal = Number(get(`SELECT COUNT(*) n FROM scenarios WHERE status IN ('PASSED','FAILED','BLOCKED')`)?.n ?? 0);
  const shieldPct = allTotal > 0 ? Math.round((passedTotal / allTotal) * 1000) / 10 : 100;

  return {
    generatedAt: now.toISOString(),
    stats: {
      missionsToday: Number(get(`SELECT COUNT(*) n FROM runs WHERE started_at >= ?`, today)?.n ?? 0),
      bugsToday: bugsAll.filter((b) => b.ts >= today).length,
      scenariosToday: Number(get(`SELECT COUNT(*) n FROM scenarios WHERE ended_at >= ? AND status IN ('PASSED','FAILED','BLOCKED','NEEDS_REVIEW')`, today)?.n ?? 0),
      streakDays: streak,
      shieldPct,
    },
    runs, pending, bugs: bugsAll.slice(0, 36), timeline,
    agents: agentScores(all), badges: badges(all, get),
  };
}

function buildRun(r: Row, all: (sql: string, ...a: (string | number)[]) => Row[], get: (sql: string, ...a: (string | number)[]) => Row | undefined, opts: BuildOptions): LiveRun {
  const id = str(r.id);
  const agent = agentKind(r.agent);
  const scenarios = all(`SELECT id, code, title, priority, status, classification FROM scenarios WHERE run_id = ? ORDER BY seq`, id);
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
      case 'scenario.reclassify': push(e.ts, `${code} reclassificado ${str(p.from)} → ${str(p.to)}`, 'warn'); break;
      case 'scenario.add': push(e.ts, `achou caminho novo: ${str(p.code)}`, 'info'); break;
      case 'guard.block': push(e.ts, `${code ? `${code} ` : ''}guard ${str(p.level)}: ${str(p.reason)}${p.needsApproval ? ' — precisa de você' : ''}`, 'ask'); break;
      case 'guard.mutation': push(e.ts, `${code ? `${code} ` : ''}alteração de dados percebida pela rede`, 'warn'); break;
      case 'data.register': push(e.ts, `${code ? `${code} ` : ''}dado criado registrado para limpeza`, 'info'); break;
      case 'data.detected': push(e.ts, `${code ? `${code} ` : ''}dado criado detectado`, 'info'); break;
      case 'cleanup.verified': push(e.ts, 'limpeza verificada', 'ok'); break;
      case 'cleanup.failed': push(e.ts, 'limpeza falhou', 'bad'); break;
      case 'http.error': push(e.ts, `${code ? `${code} ` : ''}API respondeu erro ${str(p.status)} ${str(p.method)} ${str(p.path ?? p.url).slice(0, 80)}`.trim(), 'bad'); break;
      case 'browser.open': push(e.ts, 'abriu o navegador', 'muted'); break;
      case 'network.simulate': push(e.ts, `${code ? `${code} ` : ''}simulou falha de rede`, 'warn'); break;
      case 'run.complete': push(e.ts, `missão concluída: ${str(p.recommendation)}`, p.recommendation === 'APROVADO' ? 'ok' : p.recommendation === 'REPROVADO' ? 'bad' : 'warn'); break;
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
    scenarios: scenarios.map((s) => ({ code: str(s.code), title: str(s.title), priority: str(s.priority), status: str(s.status), classification: s.classification ? str(s.classification) : null })),
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
    report: existsSync(join(opts.rootDir, 'reports', str(r.issue_key), `${id}.html`)),
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
    const risk = sc?.risk ? str(sc.risk) : 'MEDIUM';
    const title = sc?.title ? str(sc.title) : b.title;
    let rarity: 'common' | 'rare' | 'epic' | 'legendary' = 'common';
    if (prio === 'P0' && (risk === 'HIGH' || /permiss|admin|seguran|dados|vazamento/i.test(title))) {
      rarity = 'legendary';
    } else if (prio === 'P0' || risk === 'HIGH') {
      rarity = 'epic';
    } else if (prio === 'P1') {
      rarity = 'rare';
    } else {
      rarity = 'common';
    }
    b.priority = prio;
    b.rarity = rarity;

    const ev = all(`SELECT path FROM evidence WHERE run_id = ? AND kind = 'screenshot' AND (scenario_id = (SELECT id FROM scenarios WHERE run_id = ? AND code = ?) OR path LIKE ?) ORDER BY id DESC LIMIT 1`, b.runId, b.runId, b.code, `%${b.code}%`)[0] as { path?: string } | undefined;
    b.screenshot = ev?.path ? `/${str(ev.path).replace(/\\/g, '/')}` : null;
  }
  return result.sort((a, b) => b.ts.localeCompare(a.ts));
}

/** XP real: 10 por cenário concluído, 30 por missão concluída, 50 por bug explicado no relatório. */
function agentScores(all: (sql: string, ...a: (string | number)[]) => Row[]): AgentScore[] {
  const xp = new Map<AgentKind, number>();
  const add = (k: AgentKind, n: number) => xp.set(k, (xp.get(k) ?? 0) + n);
  for (const r of all(`SELECT r.agent, COUNT(s.id) n FROM runs r JOIN scenarios s ON s.run_id = r.id
                       WHERE s.status IN ('PASSED','FAILED','BLOCKED','NEEDS_REVIEW') GROUP BY r.agent`)) add(agentKind(r.agent), 10 * Number(r.n));
  for (const r of all(`SELECT agent, COUNT(*) n FROM runs WHERE status = 'COMPLETED' GROUP BY agent`)) add(agentKind(r.agent), 30 * Number(r.n));
  for (const r of all(`SELECT r.agent, e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE e.type = 'report.explain'`)) add(agentKind(r.agent), 50 * parse<unknown[]>(r.payload, []).length);
  return [...xp].map(([agent, total]) => {
    const level = Math.floor(Math.sqrt(total / 50)) + 1;
    return { agent, label: LABEL[agent], xp: total, level, title: TITLES[Math.min(TITLES.length - 1, Math.floor((level - 1) / 4))]!, base: 50 * (level - 1) ** 2, next: 50 * level ** 2 };
  }).sort((a, b) => b.xp - a.xp);
}

function badges(all: (sql: string, ...a: (string | number)[]) => Row[], get: (sql: string, ...a: (string | number)[]) => Row | undefined): Badge[] {
  const n = (sql: string) => Number(get(sql)?.n ?? 0);
  const bugs = all(`SELECT payload FROM events WHERE type = 'report.explain'`).reduce((acc, r) => acc + parse<unknown[]>(r.payload, []).length, 0);
  const maxScen = n(`SELECT MAX(c) n FROM (SELECT COUNT(*) c FROM scenarios WHERE status IN ('PASSED','FAILED','BLOCKED','NEEDS_REVIEW') GROUP BY run_id)`);
  const totalScen = n(`SELECT COUNT(*) n FROM scenarios WHERE status IN ('PASSED','FAILED','BLOCKED','NEEDS_REVIEW')`);
  const approvedRuns = n(`SELECT COUNT(*) n FROM runs WHERE status = 'COMPLETED' AND recommendation = 'APROVADO'`);
  const flawlessRuns = n(`SELECT COUNT(*) n FROM runs r WHERE r.recommendation = 'APROVADO' AND (SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id) >= 10
                 AND NOT EXISTS (SELECT 1 FROM scenarios s WHERE s.run_id = r.id AND s.status IN ('FAILED', 'BLOCKED'))`);
  const cleanRuns = n(`SELECT COUNT(*) n FROM runs r WHERE r.status = 'COMPLETED' AND EXISTS (SELECT 1 FROM created_data d WHERE d.run_id = r.id)
                 AND NOT EXISTS (SELECT 1 FROM created_data d WHERE d.run_id = r.id AND d.cleanup_status <> 'VERIFIED')`);
  const guardBlocks = n(`SELECT COUNT(*) n FROM events WHERE type = 'guard.block'`);
  const retestsApproved = n(`SELECT COUNT(*) n FROM runs WHERE mode = 'retest' AND recommendation = 'APROVADO'`);
  const speedRuns = n(`SELECT COUNT(*) n FROM runs WHERE status = 'COMPLETED' AND recommendation = 'APROVADO' AND ended_at IS NOT NULL AND (strftime('%s', ended_at) - strftime('%s', started_at)) BETWEEN 5 AND 300`);
  const maxSquad = n(`SELECT MAX(c) n FROM (SELECT COUNT(DISTINCT json_extract(agent, '$.client')) c FROM runs WHERE agent IS NOT NULL GROUP BY substr(started_at, 1, 10))`);
  const distinctAgents = n(`SELECT COUNT(DISTINCT json_extract(agent, '$.client')) n FROM runs WHERE agent IS NOT NULL`);

  return [
    // ── Trilha I: Caçador do Abismo (Bugs & Bestas Aprisionadas) ──
    { id: 'first-bug', icon: '🩸', tier: 'bronze', name: 'Primeiro Sangue', hint: 'Abater e catalogar a primeira besta no grimório da fortaleza', progress: `${Math.min(bugs, 1)}/1`, unlocked: bugs >= 1 },
    { id: 'hunter', icon: '🕷️', tier: 'prata', name: 'Exterminador do Abismo', hint: 'Aprisionar 25 bestas na masmorra da guilda', progress: `${Math.min(bugs, 25)}/25`, unlocked: bugs >= 25 },
    { id: 'beast-slayer', icon: '⚔️', tier: 'ouro', name: 'Flagelo das Trevas', hint: 'Capturar e desvendar 50 bestas catalogadas no covil', progress: `${Math.min(bugs, 50)}/50`, unlocked: bugs >= 50 },
    { id: 'reaper', icon: '💀', tier: 'lendario', name: 'Ceifador Arcano do Abismo', hint: 'Alcançar a marca lendária de 100 bestas exterminadas', progress: `${Math.min(bugs, 100)}/100`, unlocked: bugs >= 100 },

    // ── Trilha II: Incursões & Profundezas (Câmaras & Criptas) ──
    { id: 'crypt-walker', icon: '🕯️', tier: 'bronze', name: 'Explorador da Cripta', hint: 'Conquistar uma masmorra com 10+ câmaras provadas em um único run', progress: `${Math.min(maxScen, 10)}/10`, unlocked: maxScen >= 10 },
    { id: 'marathon', icon: '🏰', tier: 'prata', name: 'Grande Incursão Profunda', hint: 'Incursão perigosa com 25+ câmaras provadas em combate', progress: `${Math.min(maxScen, 25)}/25`, unlocked: maxScen >= 25 },
    { id: 'titan-labyrinth', icon: '🏛️', tier: 'ouro', name: 'Labirinto dos Titãs', hint: 'Incursão abissal extrema com 50+ câmaras provadas em um run', progress: `${Math.min(maxScen, 50)}/50`, unlocked: maxScen >= 50 },
    { id: 'world-scout', icon: '🌌', tier: 'lendario', name: 'Cartógrafo do Infinito', hint: 'Mais de 200 câmaras provadas e purificadas acumuladas pela Ordem', progress: `${Math.min(totalScen, 200)}/200`, unlocked: totalScen >= 200 },

    // ── Trilha III: Triunfo & Mestria Tática (Vitórias & Pureza) ──
    { id: 'first-victory', icon: '⚜️', tier: 'bronze', name: 'Glória da Ordem', hint: 'Masmorra concluída com veredicto supremo de APROVADO', progress: `${Math.min(approvedRuns, 1)}/1`, unlocked: approvedRuns >= 1 },
    { id: 'flawless', icon: '👑', tier: 'prata', name: 'Triunfo Imaculado', hint: 'Masmorra de 10+ câmaras conquistada sem nenhuma derrota ou bloqueio', progress: `${Math.min(flawlessRuns, 1)}/1`, unlocked: flawlessRuns >= 1 },
    { id: 'citadel-champion', icon: '🏆', tier: 'ouro', name: 'Bastião Invencível', hint: 'Conquistar 5 masmorras distintas aprovadas com triunfos soberanos', progress: `${Math.min(approvedRuns, 5)}/5`, unlocked: approvedRuns >= 5 },
    { id: 'warlord', icon: '🎖️', tier: 'lendario', name: 'Mestre Supremo da Guerra', hint: '10 masmorras conquistadas e purificadas com aprovação da corte', progress: `${Math.min(approvedRuns, 10)}/10`, unlocked: approvedRuns >= 10 },
    { id: 'retest', icon: '🔁', tier: 'prata', name: 'Expurgo Triunfal', hint: 'Reteste expurgou todas as falhas e purificou o card', progress: `${Math.min(retestsApproved, 1)}/1`, unlocked: retestsApproved >= 1 },
    { id: 'speedrun', icon: '⚡', tier: 'ouro', name: 'Incursão Relâmpago', hint: 'Masmorra aprovada e purificada em menos de 5 minutos de batalha', progress: `${Math.min(speedRuns, 1)}/1`, unlocked: speedRuns >= 1 },

    // ── Trilha IV: Vigilância, Rituais & Irmandade (Defesa & Comitiva) ──
    { id: 'clean', icon: '🧹', tier: 'bronze', name: 'Purificador da Ordem', hint: 'Masmorra concluída com todo rastro de dados purificado', progress: `${Math.min(cleanRuns, 1)}/1`, unlocked: cleanRuns >= 1 },
    { id: 'void-alchemist', icon: '🧪', tier: 'ouro', name: 'Alquimista do Vazio', hint: '5 masmorras com todo rastro de dados expurgado da existência', progress: `${Math.min(cleanRuns, 5)}/5`, unlocked: cleanRuns >= 5 },
    { id: 'guardian', icon: '🛡️', tier: 'bronze', name: 'Escudo Inabalável', hint: 'Guardião deteve ritual perigoso de ação de risco', progress: `${Math.min(guardBlocks, 1)}/1`, unlocked: guardBlocks >= 1 },
    { id: 'iron-bastion', icon: '⛩️', tier: 'ouro', name: 'Muralha de Ferro Rúnico', hint: 'Neutralizar 5 rituais de risco iminente na fortaleza', progress: `${Math.min(guardBlocks, 5)}/5`, unlocked: guardBlocks >= 5 },
    { id: 'squad', icon: '🤝', tier: 'prata', name: 'Comitiva Lendária', hint: 'Dois campeões operaram em batalha no mesmo dia em conjunto', progress: `${Math.min(maxSquad, 2)}/2`, unlocked: maxSquad >= 2 },
    { id: 'conclave-triad', icon: '🧙‍♂️', tier: 'lendario', name: 'Conclave da Tríade Sagrada', hint: 'Os três campeões lendários (Ladino, Arquimago e Paladino) operando na guilda', progress: `${Math.min(distinctAgents, 3)}/3`, unlocked: distinctAgents >= 3 },
  ];
}
