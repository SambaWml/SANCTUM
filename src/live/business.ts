import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadStaging } from '../knowledge/staging.ts';
import { loadSystemMap } from '../knowledge/system-map.ts';
import { DigestCache } from '../sources/digest.ts';
import { planCoverage } from '../state/coverage.ts';
import type { Db } from '../state/db.ts';
import { confirmedBugs } from './state.ts';

/**
 * Visão de negócio do painel (12/11): o que o trabalho rendeu no período — cards testados, bugs
 * confirmados, aprovação de primeira, tempo por card, cobertura dos critérios e consumo — em vez de
 * só o que o agente está fazendo. Tudo calculado do banco; nada estimado sem fonte (custo em reais
 * fica de fora até haver tabela de preço: mostra-se o consumo em tokens).
 */

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const FREE = 'EXPLORA-';

export interface Kpi { value: number | null; prev: number | null; spark: number[] }
export interface BusinessState {
  period: { days: number; from: string; to: string };
  kpis: {
    cards: Kpi; bugs: Kpi & { jira: number }; firstPass: Kpi; avgMinutes: Kpi;
    coverage: Kpi & { uncovered: number }; consumption: Kpi; explorations: number;
  };
  results: {
    runId: string; card: string; title: string | null; mode: string; verdict: string; endedAt: string; minutes: number | null;
    counts: Record<string, number>; bugs: number; jira: string[]; report: boolean;
  }[];
  failingModules: { name: string; failures: number }[];
  knowledge: { project: string; staging: number; mapScreens: number }[];
  questions: { id: number; project: string; runId: string; text: string; options: string[] }[];
  stages: Record<string, { steps: string[]; current: number }>;
  /** Cards com teste concluído: reteste e automação só valem para eles. */
  testedCards: string[];
}

export function buildBusiness(db: Db, opts: { rootDir: string; now?: Date; days?: number; projects?: string[] }): BusinessState {
  const now = opts.now ?? new Date();
  const days = [1, 7, 30].includes(opts.days ?? 7) ? (opts.days ?? 7) : 7;
  const span = days * 86400_000;
  const from = new Date(now.getTime() - span);
  const prevFrom = new Date(now.getTime() - 2 * span);
  const all = (sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as Row[];
  const cache = new DigestCache(db, opts.rootDir);

  const completed = (a: Date, b: Date) => all(`SELECT * FROM runs WHERE status = 'COMPLETED' AND ended_at >= ? AND ended_at < ? ORDER BY ended_at DESC`, a.toISOString(), b.toISOString());
  const cur = completed(from, now);
  const prev = completed(prevFrom, from);
  const cards = (rows: Row[]) => rows.filter((r) => !str(r.issue_key).startsWith(FREE));
  const minutesOf = (r: Row) => (r.ended_at ? Math.round((Date.parse(str(r.ended_at)) - Date.parse(str(r.started_at))) / 60_000) : null);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((n, x) => n + x, 0) / xs.length) : null);
  const firstPass = (rows: Row[]) => {
    const first = cards(rows).filter((r) => str(r.mode) !== 'retest');
    return first.length ? Math.round((100 * first.filter((r) => r.recommendation === 'APROVADO').length) / first.length) : null;
  };
  const coverage = (rows: Row[]) => {
    let covered = 0, total = 0;
    for (const r of cards(rows).filter((x) => str(x.mode) !== 'retest')) {
      const hit = cache.get('jira', str(r.issue_key), undefined, { internal: true });
      const criteria = hit.hit ? ((hit.digest as { acceptanceCriteria?: string[] }).acceptanceCriteria ?? []) : [];
      if (!criteria.length) continue;
      const executed = all(`SELECT code, title, expected FROM scenarios WHERE run_id = ? AND status IN ('PASSED','FAILED','NEEDS_REVIEW')`, str(r.id))
        .map((s) => ({ code: str(s.code), title: str(s.title), expected: str(s.expected) }));
      const cov = planCoverage(criteria, executed);
      covered += cov.covered.length;
      total += cov.covered.length + cov.uncovered.length;
    }
    return { pct: total ? Math.round((100 * covered) / total) : null, uncovered: total - covered };
  };
  const tokens = (a: Date, b: Date) => Number((db.prepare(`SELECT COALESCE(SUM(input + output + cache_write), 0) n FROM model_usage WHERE ts >= ? AND ts < ?`)
    .get(a.toISOString(), b.toISOString()) as { n: number }).n);

  const bugs = confirmedBugs(all);
  const bugIn = (a: Date, b: Date) => [...bugs.entries()].filter(([, v]) => v.ts >= a.toISOString() && v.ts < b.toISOString());
  const jiraKeys = new Map<string, string>();
  for (const e of all(`SELECT run_id, payload FROM events WHERE type IN ('report.explain','report.summaries') AND payload LIKE '%"jira"%' ORDER BY id`)) {
    try { for (const x of JSON.parse(str(e.payload)) as { code: string; jira?: string }[]) if (x.jira) jiraKeys.set(`${str(e.run_id)}:${x.code}`, x.jira); } catch { /* payload inválido não derruba o painel */ }
  }

  // Sete fatias do período, para a tendência de cada indicador.
  const slices = Array.from({ length: 7 }, (_, i) => [new Date(from.getTime() + (span * i) / 7), new Date(from.getTime() + (span * (i + 1)) / 7)] as const);
  const spark = (f: (a: Date, b: Date) => number | null) => slices.map(([a, b]) => f(a, b) ?? 0);

  const curCov = coverage(cur);
  const kpis: BusinessState['kpis'] = {
    cards: { value: new Set(cards(cur).map((r) => str(r.issue_key))).size, prev: new Set(cards(prev).map((r) => str(r.issue_key))).size,
      spark: spark((a, b) => new Set(cards(completed(a, b)).map((r) => str(r.issue_key))).size) },
    bugs: { value: bugIn(from, now).length, prev: bugIn(prevFrom, from).length, jira: bugIn(from, now).filter(([k]) => jiraKeys.has(k)).length,
      spark: spark((a, b) => bugIn(a, b).length) },
    firstPass: { value: firstPass(cur), prev: firstPass(prev), spark: spark((a, b) => firstPass(completed(a, b))) },
    avgMinutes: { value: avg(cards(cur).map(minutesOf).filter((x): x is number => x !== null)), prev: avg(cards(prev).map(minutesOf).filter((x): x is number => x !== null)),
      spark: spark((a, b) => avg(cards(completed(a, b)).map(minutesOf).filter((x): x is number => x !== null))) },
    coverage: { value: curCov.pct, prev: coverage(prev).pct, uncovered: curCov.uncovered, spark: [] },
    // Não chamar de "tokens": o redator do painel apaga campos com esse nome.
    consumption: { value: tokens(from, now), prev: tokens(prevFrom, from), spark: spark(tokens) },
    explorations: cur.filter((r) => str(r.issue_key).startsWith(FREE)).length,
  };

  const results = cur.slice(0, 12).map((r) => {
    const id = str(r.id);
    const counts: Record<string, number> = {};
    for (const s of all(`SELECT status, COUNT(*) n FROM scenarios WHERE run_id = ? GROUP BY status`, id)) counts[str(s.status)] = Number(s.n);
    const runBugs = [...bugs.keys()].filter((k) => k.startsWith(`${id}:`));
    const hit = cache.get('jira', str(r.issue_key), undefined, { internal: true });
    return {
      runId: id, card: str(r.issue_key), title: hit.hit ? str((hit.digest as { title?: string }).title) || null : null, mode: str(r.mode),
      // Missão sem card não aprova nem reprova (as antigas gravaram APROVADO antes dessa regra).
      verdict: str(r.issue_key).startsWith(FREE) ? 'EXPLORADO' : r.recommendation ? str(r.recommendation) : 'SEM VEREDITO',
      endedAt: str(r.ended_at), minutes: minutesOf(r), counts, bugs: runBugs.length,
      jira: [...new Set(runBugs.map((k) => jiraKeys.get(k)).filter((x): x is string => !!x))],
      report: existsSync(join(opts.rootDir, 'reports', str(r.issue_key), `${id}.html`)),
    };
  });

  // Onde mais falha: cenário FAILED por módulo (o primeiro módulo do run; sem módulo, o projeto).
  const fails = new Map<string, number>();
  for (const s of all(`SELECT r.modules, r.project FROM scenarios s JOIN runs r ON r.id = s.run_id WHERE s.status = 'FAILED' AND s.ended_at >= ?`, from.toISOString())) {
    let name = str(s.project);
    try { const m = JSON.parse(str(s.modules)) as string[]; if (m[0]) name = m[0]; } catch { /* sem módulos */ }
    fails.set(name, (fails.get(name) ?? 0) + 1);
  }

  const projects = opts.projects ?? [...new Set(all(`SELECT DISTINCT project FROM runs`).map((r) => str(r.project)))];
  const knowledge = projects.map((p) => ({
    project: p,
    staging: loadStaging(opts.rootDir, p).reduce((n, s) => n + s.proposals.length, 0),
    mapScreens: loadSystemMap(opts.rootDir, p)?.screens.length ?? 0,
  })).filter((k) => k.staging || k.mapScreens);

  const questions = all(`SELECT id, project, run_id, text, options FROM questions WHERE status = 'OPEN' ORDER BY id`).map((q) => ({
    id: Number(q.id), project: str(q.project), runId: str(q.run_id), text: str(q.text),
    options: (() => { try { return q.options ? (JSON.parse(str(q.options)) as string[]) : []; } catch { return []; } })(),
  }));

  // Etapas de cada run ativo, com nomes de negócio. Missão exploratória tem a fase de descoberta antes do plano.
  const stages: BusinessState['stages'] = {};
  for (const r of all(`SELECT id, mode, status, project FROM runs WHERE status IN ('PLANNING','AWAITING_APPROVAL','EXECUTING')`)) {
    const id = str(r.id);
    const status = str(r.status);
    const pendingScen = Number((db.prepare(`SELECT COUNT(*) n FROM scenarios WHERE run_id = ? AND status IN ('PENDING','IN_PROGRESS')`).get(id) as { n: number }).n);
    const openCharters = Number((db.prepare(`SELECT COUNT(*) n FROM charters WHERE run_id = ? AND status IN ('PLANNED','OPEN')`).get(id) as { n: number }).n);
    if (str(r.mode) === 'explore') {
      const steps = ['Mapa', 'Perguntas', 'Plano', 'Execução', 'Exploração'];
      const hasMap = !!loadSystemMap(opts.rootDir, str(r.project));
      const open = questions.some((q) => q.runId === id);
      const current = status === 'EXECUTING' ? (pendingScen ? 3 : 4)
        : status === 'AWAITING_APPROVAL' ? 2 : !hasMap ? 0 : open ? 1 : 2;
      stages[id] = { steps, current };
    } else {
      const steps = ['Plano', 'Aprovação', 'Execução', 'Exploração'];
      const current = status === 'PLANNING' ? 0 : status === 'AWAITING_APPROVAL' ? 1 : pendingScen ? 2 : openCharters ? 3 : 3;
      stages[id] = { steps, current };
    }
  }

  return {
    period: { days, from: from.toISOString(), to: now.toISOString() },
    kpis, results,
    failingModules: [...fails.entries()].map(([name, failures]) => ({ name, failures })).sort((a, b) => b.failures - a.failures).slice(0, 6),
    knowledge, questions, stages,
    testedCards: all(`SELECT DISTINCT issue_key FROM runs WHERE status = 'COMPLETED' AND issue_key NOT LIKE 'EXPLORA-%'`).map((r) => str(r.issue_key)),
  };
}
