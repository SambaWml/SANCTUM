import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { buildBusiness } from '../src/live/business.ts';
import { buildLiveState } from '../src/live/state.ts';
import { openDb } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';

/**
 * Painel de operação (/): roda o script da página com um DOM falso e um estado real do banco, e
 * confere os números de negócio calculados a partir de runs registrados.
 */
const config = loadConfig(join(import.meta.dirname, '..'));
const PAGE = readFileSync(join(import.meta.dirname, '..', 'src', 'live', 'panel.html'), 'utf8');

function fakeElement(): unknown {
  const t: Record<string, unknown> = { style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, innerHTML: '', textContent: '', value: '', hidden: false };
  return new Proxy(t, {
    get(o, k) {
      if (k in o) return o[k as string];
      if (k === 'querySelectorAll') return () => [];
      if (k === 'parentElement' || k === 'querySelector') return k === 'parentElement' ? fakeElement() : () => fakeElement();
      return typeof k === 'string' ? () => fakeElement() : undefined;
    },
    set(o, k, v) { o[k as string] = v; return true; },
  });
}

async function run(state: unknown): Promise<{ errors: string[]; html: Record<string, string> }> {
  const errors: string[] = [];
  const els = new Map<string, Record<string, unknown>>();
  const byId = (id: string) => { if (!els.has(id)) els.set(id, fakeElement() as Record<string, unknown>); return els.get(id)!; };
  const src = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
  let calls = 0;
  const fetch = async () => (++calls > 1 ? new Promise(() => {}) : { ok: true, json: async () => state });
  const document = { getElementById: byId, querySelector: () => fakeElement(), querySelectorAll: () => [], addEventListener() {}, title: '', hidden: false };
  try {
    new Function('document', 'fetch', 'console', 'setTimeout', 'clearTimeout', 'alert', src)(
      document, fetch, { error: (...a: unknown[]) => errors.push(a.map(String).join(' ')), log() {} }, () => 0, () => {}, () => {});
  } catch (e) {
    errors.push(`carga: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 30));
  return { errors, html: Object.fromEntries([...els].map(([k, v]) => [k, String(v.innerHTML ?? '')])) };
}

describe('painel de operação', () => {
  it('desenha indicadores, fila de decisões, andamento e resultados sem erro', async () => {
    const db = openDb(':memory:');
    let clock = new Date('2026-11-10T10:00:00Z');
    const store = new StateStore(db, config, { now: () => clock });
    store.agent = { client: 'claude-code' };
    const scenario = (code: string) => ({ code, title: `${code} contadores`, priority: 'P1' as const, risk: 'MEDIUM' as const, types: ['functional'], preconditions: 'admin', steps: ['x'], expected: 'contador correto' });
    // Um card concluído e reprovado com bug confirmado; outro aguardando aprovação do plano.
    const done = store.startRun({ issueKey: 'FIX-1', env: 'fixture-local', mode: 'manual' });
    store.savePlan(done.id, [scenario('CT-001'), scenario('CT-002')]);
    store.approvePlan(done.id);
    store.startScenario(done.id, 'CT-001');
    store.recordVerification(done.id, 'CT-001', { kind: 'network', description: 'ok', passed: true });
    store.completeScenario(done.id, 'CT-001', { status: 'PASSED' });
    store.startScenario(done.id, 'CT-002');
    store.recordEvidence(done.id, 'CT-002', { kind: 'screenshot', path: 'x.png' });
    store.recordVerification(done.id, 'CT-002', { kind: 'ui', description: 'contador', passed: false });
    store.recordVerification(done.id, 'CT-002', { kind: 'ui', description: 'contador', passed: false });
    store.completeScenario(done.id, 'CT-002', { status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'contador soma canceladas' });
    clock = new Date('2026-11-10T11:30:00Z');
    store.completeRun(done.id, 'REPROVADO', 'contador errado', );
    const waiting = store.startRun({ issueKey: 'FIX-2', env: 'fixture-local', mode: 'manual' });
    store.savePlan(waiting.id, [scenario('CT-001')]);

    const now = new Date('2026-11-12T12:00:00Z');
    const business = buildBusiness(db, { rootDir: join(import.meta.dirname, '..'), now, days: 7 });
    expect(business.kpis.cards.value).toBe(1);
    expect(business.kpis.bugs.value).toBe(1);
    expect(business.kpis.firstPass.value).toBe(0);
    expect(business.kpis.avgMinutes.value).toBe(90);
    expect(business.results[0]).toMatchObject({ card: 'FIX-1', verdict: 'REPROVADO', bugs: 1, counts: { PASSED: 1, FAILED: 1 } });
    expect(business.stages[waiting.id]).toMatchObject({ steps: ['Plano', 'Aprovação', 'Execução', 'Exploração'], current: 1 });

    const state = { ...buildLiveState(db, { rootDir: '/x', now }), business, usage: { agents: [] }, missions: [], prompts: [], staleSince: null };
    const { errors, html } = await run(state);
    expect(errors).toEqual([]);
    expect(html.queue).toMatch(/Aprovar plano · <span class="key">FIX-2<\/span>[\s\S]*aprove no terminal do agente/);
    expect(html.results).toMatch(/FIX-1[\s\S]*Reprovado/);
    expect(html.kpis).toMatch(/Cards testados[\s\S]*Bugs confirmados/);
    expect(html.kpis).not.toMatch(/undefined|NaN/);
    expect(html.running).toMatch(/FIX-2/);
  });

  it('missão sem card aparece como "Explorado", nunca aprovada', () => {
    const db = openDb(':memory:');
    let clock = new Date('2026-11-10T10:00:00Z');
    const store = new StateStore(db, config, { now: () => clock, charterMin: { minutes: 0, activity: 0 } });
    const r = store.startRun({ issueKey: 'EXPLORA-202611101000', env: 'fixture-local', mode: 'explore' });
    store.savePlan(r.id, [{ code: 'CT-001', title: 'Linha de base', priority: 'P2', risk: 'LOW', types: ['functional'], preconditions: 'admin', steps: ['x'], expected: 'painel visível' }]);
    store.approvePlan(r.id);
    store.startScenario(r.id, 'CT-001');
    store.recordVerification(r.id, 'CT-001', { kind: 'ui', description: 'painel', passed: true });
    store.completeScenario(r.id, 'CT-001', { status: 'PASSED' });
    clock = new Date('2026-11-10T10:20:00Z');
    store.completeRun(r.id, 'APROVADO', 'explorado');
    const b = buildBusiness(db, { rootDir: join(import.meta.dirname, '..'), now: new Date('2026-11-12T12:00:00Z'), days: 7 });
    expect(b.results[0]!.verdict).toBe('EXPLORADO');
    expect(b.kpis.cards.value).toBe(0);
    expect(b.kpis.explorations).toBe(1);
  });
});

describe('painel de operação: dados passam pelo redator sem perder indicador', () => {
  it('nenhum campo dos indicadores é apagado como segredo', async () => {
    const { Redactor } = await import('../src/security/redact.ts');
    const db = openDb(':memory:');
    const b = buildBusiness(db, { rootDir: join(import.meta.dirname, '..'), now: new Date('2026-11-12T12:00:00Z'), days: 7 });
    const out = JSON.stringify(new Redactor().value(b));
    expect(out).not.toMatch(/REDACTED/);
    expect(Object.keys((new Redactor().value(b) as typeof b).kpis)).toEqual(Object.keys(b.kpis));
  });
});

describe('painel de operação: fluxos que não podem travar', () => {
  it('missão que falhou e run sem ninguém operando aparecem na fila, com ação', async () => {
    const db = openDb(':memory:');
    const store = new StateStore(db, config, { now: () => new Date('2026-11-12T09:00:00Z') });
    const orphan = store.startRun({ issueKey: 'FIX-9', env: 'fixture-local', mode: 'manual' });
    const now = new Date('2026-11-12T12:00:00Z');
    const business = buildBusiness(db, { rootDir: join(import.meta.dirname, '..'), now, days: 7 });
    const failed = { id: 'M-20261112T110000', agent: 'antigravity', target: 'FIX-8', kind: 'qa', status: 'FAILED', error: 'error: Individual quota reached.', last_message: null, created_at: now.toISOString(), updated_at: now.toISOString(), run_id: null, runId: null, messages: [], activity: [] };
    const state = { ...buildLiveState(db, { rootDir: '/x', now }), business, usage: { agents: [] }, missions: [failed], prompts: [], staleSince: null };
    const { errors, html } = await run(state);
    expect(errors).toEqual([]);
    expect(html.queue).toMatch(/Missão falhou · <span class="key">FIX-8<\/span>[\s\S]*Individual quota reached/);
    expect(html.queue).toMatch(/Ninguém está operando · <span class="key">FIX-9<\/span>[\s\S]*Parado há 3h00/);
    expect(orphan.status).toBe('PLANNING');
  });

  it('encerrar run abandonado pelo painel: grava o motivo; com missão trabalhando nele, recusa', async () => {
    const { MissionManager } = await import('../src/live/missions.ts');
    const db = openDb(':memory:');
    const store = new StateStore(db, config);
    const r = store.startRun({ issueKey: 'FIX-9', env: 'fixture-local', mode: 'manual' });
    const missions = new MissionManager({ db, rootDir: '/x', logDir: join(import.meta.dirname, '..', 'data', 'missions'), killTree: () => {}, isAlive: () => false });
    db.prepare(`INSERT INTO missions (id, agent, target, kind, status, created_at, updated_at, run_id) VALUES ('M-1', 'claude', 'FIX-9', 'qa', 'RUNNING', ?, ?, ?)`).run('2026-11-12', '2026-11-12', r.id);
    expect(() => missions.abortRun(r.id, 'x')).toThrow(/pare a missão antes/);
    db.prepare(`UPDATE missions SET status = 'STOPPED' WHERE id = 'M-1'`).run();
    missions.abortRun(r.id, 'ninguém estava operando');
    expect(store.getRun(r.id)).toMatchObject({ status: 'ABORTED', summary: 'ninguém estava operando' });
    expect(() => missions.abortRun(r.id, 'de novo')).toThrow(/já está ABORTED/);
  });
});

describe('nova missão: um campo só, o painel reconhece card ou sistema', () => {
  const cases: [string, unknown][] = [
    ['GURUJA-9040', { kind: 'card', key: 'GURUJA-9040' }],
    ['guruja-9040', { kind: 'card', key: 'GURUJA-9040' }],
    ['https://luby.atlassian.net/browse/GURUJA-9040', { kind: 'card', key: 'GURUJA-9040' }],
    ['https://x.atlassian.net/jira/software/projects/G/boards/1?selectedIssue=GURUJA-77', { kind: 'card', key: 'GURUJA-77' }],
    ['pava2-hml.ducotravelsummit.com/login', { kind: 'url', url: 'https://pava2-hml.ducotravelsummit.com/login' }],
    ['www.sistema.com', { kind: 'url', url: 'https://www.sistema.com/' }],
    ['localhost:3000', { kind: 'url', url: 'http://localhost:3000/' }],
    ['192.168.0.10:8080/app', { kind: 'url', url: 'http://192.168.0.10:8080/app' }],
    ['http://sistema.local', { kind: 'url', url: 'http://sistema.local/' }],
    ['https://app.exemplo.com/pedido/ABC-12', { kind: 'url', url: 'https://app.exemplo.com/pedido/ABC-12' }],
  ];
  it('no painel e no servidor, com a mesma regra', async () => {
    const { parseTarget } = await import('../src/live/server.ts');
    const start = PAGE.indexOf('function parseTarget(raw)');
    const end = PAGE.indexOf('let fixedKind');
    const pageParse = new Function(`${PAGE.slice(start, end)}; return parseTarget;`)() as (raw: string) => unknown;
    for (const [input, want] of cases) {
      expect(pageParse(input), input).toEqual(want);
      expect(parseTarget(input), input).toEqual(want);
    }
    expect(pageParse('texto qualquer')).toEqual({ kind: 'invalid' });
    expect(parseTarget('texto qualquer')).toBeNull();
  });

  it('reteste e automação só para card com teste concluído; automação vira /automate', async () => {
    const { MissionManager, missionCommand } = await import('../src/live/missions.ts');
    expect(missionCommand({ kind: 'card', key: 'FIX-1' }, 'automate')).toBe('/automate FIX-1');
    const db = openDb(':memory:');
    const missions = new MissionManager({ db, rootDir: '/x', logDir: join(import.meta.dirname, '..', 'data', 'missions'), spawnFn: (() => { throw new Error('não deveria lançar'); }) as never, killTree: () => {}, isAlive: () => false });
    for (const kind of ['retest', 'automate'] as const) {
      expect(() => missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-1' }, kind })).toThrow(/ainda não tem teste concluído/);
    }
    expect(() => missions.launch({ agent: 'claude', target: { kind: 'url', url: 'https://a.com/' }, kind: 'automate' })).toThrow(/exigem um card/);
  });
});

describe('detalhe do run', () => {
  async function scenarioRun() {
    const db = openDb(':memory:');
    let clock = new Date('2026-11-12T13:00:00Z');
    const store = new StateStore(db, config, { now: () => { clock = new Date(clock.getTime() + 1000); return clock; } });
    store.agent = { client: 'claude-code' };
    const r = store.startRun({ issueKey: 'FIX-3', env: 'fixture-local', mode: 'manual' });
    store.savePlan(r.id, [
      { code: 'CT-001', title: 'Contador da meta', priority: 'P0', risk: 'HIGH', types: ['functional'], preconditions: 'aluno B', steps: ['abrir a meta'], expected: 'contador mostra 8' },
      { code: 'CT-002', title: 'Layout da meta', priority: 'P3', risk: 'LOW', types: ['visual'], preconditions: 'aluno B', steps: ['abrir'], expected: 'legível em 390' },
    ]);
    store.approvePlan(r.id);
    store.startScenario(r.id, 'CT-001');
    store.recordAction(r.id, 'CT-001', { action: 'click', target: { role: 'link', name: 'Meta' }, guardLevel: 'GREEN', ok: true });
    store.recordVerification(r.id, 'CT-001', { kind: 'api', description: 'totalDeepDives = 2', passed: true });
    store.recordVerification(r.id, 'CT-001', { kind: 'ui', description: 'contador mostra 8', passed: false, expected: '8', actual: '6' } as never);
    store.recordEvidence(r.id, 'CT-001', { kind: 'screenshot', path: 'runs/FIX-3/x/evidence/CT-001-contador.png' });
    store.logEvent(r.id, store.getScenario(r.id, 'CT-001').id, 'http.error', { status: 404, method: 'GET', path: '/api/x' });
    return { db, runId: r.id };
  }

  it('junta cenários com verificações, passo a passo por cenário, prints e sinais', async () => {
    const { runDetail } = await import('../src/live/detail.ts');
    const { db, runId } = await scenarioRun();
    const d = runDetail(db, runId, join(import.meta.dirname, '..'));
    expect(d.scenarios.map((s) => [s.code, s.status])).toEqual([['CT-001', 'IN_PROGRESS'], ['CT-002', 'PENDING']]);
    expect(d.scenarios[0]!.checks.map((c) => [c.kind, c.passed])).toEqual([['api', true], ['ui', false]]);
    expect(d.scenarios[0]!.signals).toEqual({ consoleErrors: 0, httpErrors: 1, createdData: 0 });
    expect(d.shots).toEqual([expect.objectContaining({ code: 'CT-001', name: 'CT-001-contador.png', exists: false })]);
    const texts = d.steps.map((s) => `${s.code ?? '-'} ${s.kind} ${s.text}`);
    expect(texts).toEqual(expect.arrayContaining(['- you plano aprovado', 'CT-001 action clicou em "Meta"', 'CT-001 check ✓ api: totalDeepDives = 2', 'CT-001 shot print: CT-001-contador.png', 'CT-001 fail API respondeu 404 em GET /api/x']));
    expect(texts.indexOf('- you plano aprovado')).toBeLessThan(texts.indexOf('CT-001 action clicou em "Meta"'));
    expect(d.counts).toEqual({ actions: 1, checks: 2 });
  });

  it('o painel desenha as quatro abas sem erro', async () => {
    const { runDetail } = await import('../src/live/detail.ts');
    const { buildRun } = await import('../src/live/state.ts');
    const { db, runId } = await scenarioRun();
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown>;
    const runView = buildRun(row, (sql, ...a) => db.prepare(sql).all(...a) as Record<string, unknown>[], (sql, ...a) => db.prepare(sql).get(...a) as Record<string, unknown> | undefined, { rootDir: '/x' });
    const payload = { run: runView, detail: runDetail(db, runId, '/x') };
    const els = new Map<string, Record<string, unknown>>();
    const byId = (id: string) => { if (!els.has(id)) els.set(id, fakeElement() as Record<string, unknown>); return els.get(id)!; };
    const src = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
    const fetch = async (url: string) => (String(url).includes('/detail') ? { ok: true, json: async () => payload } : new Promise(() => {}));
    const errors: string[] = [];
    const api = new Function('document', 'fetch', 'console', 'setTimeout', 'clearTimeout', 'alert', `${src}\n;return { openDetail, renderDetail, setTab: (t) => { dTab = t; }, setFilter: (f) => { dFilter = f; } };`)(
      { getElementById: byId, querySelector: () => fakeElement(), querySelectorAll: () => [], addEventListener() {}, title: '', hidden: false },
      fetch, { error: (...a: unknown[]) => errors.push(a.map(String).join(' ')), log() {} }, () => 0, () => {}, () => {}) as
      { openDetail: (id: string) => Promise<void>; renderDetail: () => void; setTab: (t: string) => void; setFilter: (f: string) => void };
    await api.openDetail(runId);
    // Aba "Agora": a última tela salva (aqui, apagada pela limpeza) e, ao lado, o cenário atual.
    expect(String(byId('d-body').innerHTML)).toMatch(/Print apagado[\s\S]*Cenário atual[\s\S]*CT-001/);
    const html: Record<string, string> = {};
    for (const t of ['cenarios', 'passos', 'evid']) { api.setTab(t); api.renderDetail(); html[t] = String(byId('d-body').innerHTML); }
    expect(html.cenarios).toMatch(/CT-001[\s\S]*✗[\s\S]*esperado 8 · obtido 6/);
    expect(html.passos).toMatch(/plano aprovado[\s\S]*CT-001[\s\S]*clicou em &quot;Meta&quot;/);
    expect(html.evid).toMatch(/1 print\(s\) deste teste foram apagados/);
    api.setTab('passos'); api.setFilter('fails'); api.renderDetail();
    expect(String(byId('d-body').innerHTML)).not.toMatch(/clicou em/);
    expect(errors).toEqual([]);
  });
});
