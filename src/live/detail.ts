import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Db } from '../state/db.ts';
import { targetName, VERB } from './state.ts';

/**
 * Detalhe de um run para o painel (12/11): o que o agente fez, passo a passo e por cenário, com as
 * verificações, os prints e o vídeo. É o que dá confiança no veredito e deixa intervir cedo.
 * Só leitura; prints apagados pela retenção aparecem como "sem arquivo", sem quebrar.
 */

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const parse = <T>(v: unknown, fallback: T): T => { try { return v ? (JSON.parse(String(v)) as T) : fallback; } catch { return fallback; } };

export type StepKind = 'action' | 'check' | 'fail' | 'event' | 'you' | 'sim' | 'shot' | 'risk';
export interface Step { ts: string; code: string | null; kind: StepKind; text: string; shot?: number }
export interface DetailScenario {
  code: string; title: string; priority: string; risk: string; status: string; classification: string | null; confidence: string | null;
  expected: string; observed: string | null; reason: string | null; startedAt: string | null; endedAt: string | null; charter: string | null;
  checks: { ts: string; kind: string; description: string; expected: string; actual: string; passed: boolean }[];
  signals: { consoleErrors: number; httpErrors: number; createdData: number };
}
export interface RunDetail {
  scenarios: DetailScenario[];
  steps: Step[];
  shots: { id: number; code: string | null; ts: string; name: string; failed: boolean; exists: boolean }[];
  video: { id: number; exists: boolean; chapters: { code: string; atSec: number }[] } | null;
  charters: { code: string; target: string; status: string; minutes: number | null; findings: string[] }[];
  counts: { actions: number; checks: number };
}

const MAX_STEPS = 600;

export function runDetail(db: Db, runId: string, rootDir: string): RunDetail {
  const all = (sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as Row[];
  const n = (sql: string, ...a: (string | number)[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);
  const fileExists = (p: unknown) => { const s = str(p); return !!s && existsSync(isAbsolute(s) ? s : join(rootDir, s)); };

  const rows = all(`SELECT * FROM scenarios WHERE run_id = ? ORDER BY seq`, runId);
  const codeOf = new Map(rows.map((s) => [Number(s.id), str(s.code)]));
  const code = (sid: unknown) => (sid === null || sid === undefined ? null : codeOf.get(Number(sid)) ?? null);

  const scenarios: DetailScenario[] = rows.map((s) => {
    const id = Number(s.id);
    const since = str(s.started_at);
    return {
      code: str(s.code), title: str(s.title), priority: str(s.priority), risk: str(s.risk), status: str(s.status),
      classification: s.classification ? str(s.classification) : null, confidence: s.confidence ? str(s.confidence) : null,
      expected: str(s.expected), observed: s.observed ? str(s.observed) : null, reason: s.reason ? str(s.reason) : null,
      startedAt: s.started_at ? str(s.started_at) : null, endedAt: s.ended_at ? str(s.ended_at) : null,
      charter: s.charter_code ? str(s.charter_code) : null,
      // Só a tentativa atual vale (reabrir zera); as verificações antigas ficam na linha do tempo.
      checks: all(`SELECT ts, kind, description, expected, actual, passed FROM verifications WHERE scenario_id = ? AND ts >= ? ORDER BY id`, id, since)
        .map((v) => ({ ts: str(v.ts), kind: str(v.kind), description: str(v.description), expected: str(v.expected), actual: str(v.actual), passed: Number(v.passed) === 1 })),
      signals: {
        consoleErrors: n(`SELECT COUNT(*) n FROM events WHERE scenario_id = ? AND type = 'console.error'`, id),
        httpErrors: n(`SELECT COUNT(*) n FROM events WHERE scenario_id = ? AND type = 'http.error'`, id),
        createdData: n(`SELECT COUNT(*) n FROM created_data WHERE scenario_id = ?`, id),
      },
    };
  });

  const failedCodes = new Set(scenarios.filter((s) => s.status === 'FAILED').map((s) => s.code));
  const shots = all(`SELECT id, scenario_id, ts, path FROM evidence WHERE run_id = ? AND kind = 'screenshot' ORDER BY id`, runId).map((e) => {
    const c = code(e.scenario_id);
    return { id: Number(e.id), code: c, ts: str(e.ts), name: str(e.path).split(/[\\/]/).pop() ?? '', failed: !!c && failedCodes.has(c), exists: fileExists(e.path) };
  });

  const steps: Step[] = [];
  for (const a of all(`SELECT * FROM actions WHERE run_id = ? ORDER BY id DESC LIMIT ${MAX_STEPS}`, runId)) {
    const verb = VERB[str(a.action)] ?? str(a.action);
    const target = a.action === 'navigate' ? str(parse<{ url?: string }>(a.target_json, {}).url) : `"${targetName(a.target_json)}"`;
    const sample = a.value_sample ? ` = "${str(a.value_sample).slice(0, 40)}"` : '';
    if (Number(a.ok)) steps.push({ ts: str(a.ts), code: code(a.scenario_id), kind: a.guard_level === 'RED' ? 'risk' : 'action', text: `${a.action === 'navigate' ? 'abriu' : verb} ${target}${sample}` });
    else steps.push({ ts: str(a.ts), code: code(a.scenario_id), kind: str(a.error).startsWith('BLOQUEADO') ? 'risk' : 'fail', text: `${verb} ${target} — ${str(a.error).slice(0, 140)}` });
  }
  for (const v of all(`SELECT * FROM verifications WHERE run_id = ? ORDER BY id DESC LIMIT ${MAX_STEPS}`, runId)) {
    const ok = Number(v.passed) === 1;
    const detail = ok ? '' : ` · esperado ${str(v.expected).slice(0, 80)}, obtido ${str(v.actual).slice(0, 80)}`;
    steps.push({ ts: str(v.ts), code: code(v.scenario_id), kind: ok ? 'check' : 'fail', text: `${ok ? '✓' : '✗'} ${str(v.kind)}: ${str(v.description)}${detail}` });
  }
  for (const e of all(`SELECT * FROM events WHERE run_id = ? AND type IN ('plan.save','plan.approve','scenario.start','scenario.complete','scenario.add','scenario.reopen','scenario.loop',
                       'charter.start','charter.end','charter.skip','network.simulate','guard.block','http.error','map.save','question.ask','question.answer','run.complete','run.abort') ORDER BY id`, runId)) {
    const p = parse<Record<string, unknown>>(e.payload, {});
    const c = code(e.scenario_id);
    const at = (kind: StepKind, text: string, cc: string | null = c) => steps.push({ ts: str(e.ts), code: cc, kind, text });
    switch (str(e.type)) {
      case 'plan.save': at('event', `montou o plano: ${str(p.count)} cenário(s)${p.charters ? ` e ${str(p.charters)} sessão(ões) exploratória(s)` : ''}`); break;
      case 'plan.approve': at('you', 'plano aprovado'); break;
      case 'scenario.start': at('event', 'começou o cenário'); break;
      case 'scenario.complete': at(p.status === 'FAILED' ? 'fail' : 'event', `concluiu: ${str(p.status)}${p.classification ? ` (${str(p.classification)})` : ''}`); break;
      case 'scenario.add': at('event', `registrou achado novo ${str(p.code)}${p.charter ? ` na sessão ${str(p.charter)}` : ''}`, null); break;
      case 'scenario.reopen': at('event', `reabriu: ${str(p.reason).slice(0, 120)}`); break;
      case 'scenario.loop': at('fail', `andando em círculo: ${str(p.actions)} ações e ${str(p.verifications)} verificações`); break;
      case 'charter.start': at('event', `abriu a sessão exploratória ${str(p.code)}`, null); break;
      case 'charter.end': at('event', `fechou a sessão ${str(p.code)}: ${str(p.minutes)} min, ${str(p.findings)} achado(s)`, null); break;
      case 'charter.skip': at('event', `pulou a sessão ${str(p.code)}: ${str(p.reason).slice(0, 120)}`, null); break;
      case 'network.simulate': at('sim', `simulou ${p.abort ? 'queda de rede' : p.delayMs ? `lentidão de ${str(p.delayMs)} ms` : `resposta ${str(p.status)}`} em ${str(p.urlContains)}`); break;
      case 'guard.block': at('risk', `ação ${str(p.level)} segurada: ${str(p.reason)}${p.needsApproval ? ' — pediu sua autorização' : ''}`); break;
      case 'http.error': at('fail', `API respondeu ${str(p.status)} em ${str(p.method)} ${str(p.path ?? p.url).slice(0, 80)}`); break;
      case 'map.save': at('event', `gravou o mapa do sistema: ${str(p.screens)} tela(s)`, null); break;
      case 'question.ask': at('event', `fez ${str(p.count)} pergunta(s) para você`, null); break;
      case 'question.answer': at('you', p.status === 'ANSWERED' ? 'você respondeu uma pergunta' : 'você dispensou uma pergunta', null); break;
      case 'run.complete': at('event', `concluiu o teste${p.recommendation ? `: ${str(p.recommendation)}` : ''}`, null); break;
      case 'run.abort': at('fail', `teste encerrado: ${str(p.reason).slice(0, 120)}`, null); break;
    }
  }
  for (const a of all(`SELECT action, target, level, ts FROM approvals WHERE run_id = ? AND level <> 'PLAN' ORDER BY id`, runId)) {
    steps.push({ ts: str(a.ts), code: null, kind: 'you', text: `você autorizou ${str(a.level)}: ${VERB[str(a.action)] ?? str(a.action)} ${str(a.target).slice(0, 80)}` });
  }
  for (const s of shots) steps.push({ ts: s.ts, code: s.code, kind: 'shot', text: `print: ${s.name}`, shot: s.id });
  steps.sort((a, b) => a.ts.localeCompare(b.ts));

  const videoRow = all(`SELECT id, path, meta FROM evidence WHERE run_id = ? AND kind = 'video' AND scenario_id IS NULL ORDER BY id DESC`, runId)
    .find((v) => (parse<{ chapters?: unknown[] }>(v.meta, {}).chapters ?? []).length > 0);
  const charters = all(`SELECT code, target, status, summary FROM charters WHERE run_id = ? ORDER BY code`, runId).map((c) => {
    const sum = parse<{ minutes?: number; findings?: string[] }>(c.summary, {});
    return { code: str(c.code), target: str(c.target), status: str(c.status), minutes: sum.minutes ?? null, findings: sum.findings ?? [] };
  });

  return {
    scenarios,
    steps: steps.slice(-MAX_STEPS),
    shots,
    video: videoRow ? { id: Number(videoRow.id), exists: fileExists(videoRow.path), chapters: parse<{ chapters?: { code: string; atSec: number }[] }>(videoRow.meta, {}).chapters ?? [] } : null,
    charters,
    counts: { actions: n(`SELECT COUNT(*) n FROM actions WHERE run_id = ?`, runId), checks: n(`SELECT COUNT(*) n FROM verifications WHERE run_id = ?`, runId) },
  };
}
