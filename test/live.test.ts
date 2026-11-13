import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { createLiveServer } from '../src/live/server.ts';
import { agentKind, buildLiveState, confirmedBugs } from '../src/live/state.ts';
import { Redactor } from '../src/security/redact.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { StateStore, type ScenarioInput } from '../src/state/store.ts';

const config = loadConfig(join(import.meta.dirname, '..'));
const ENV = 'fixture-local';
const SECRET = 'S3nh@-Muito-Secreta-42';

function scenario(code: string): ScenarioInput {
  return { code, title: `Cenário ${code}`, priority: 'P1', risk: 'HIGH', types: ['functional'], steps: ['passo'], expected: 'resultado' };
}

let db: Db;
let store: StateStore;
let clock: Date;
let root: string;

beforeEach(() => {
  db = openDb(':memory:');
  clock = new Date('2026-11-03T10:00:00Z');
  store = new StateStore(db, config, { now: () => clock });
  store.agent = { client: 'claude-code', version: '2' };
  root = mkdtempSync(join(tmpdir(), 'sanctum-live-'));
});

const tick = (s = 5) => { clock = new Date(clock.getTime() + s * 1000); };

function executingRun(): string {
  const run = store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'manual' });
  tick(); store.savePlan(run.id, [scenario('CT-001'), scenario('CT-002')]);
  tick(); store.approvePlan(run.id);
  return run.id;
}

describe('estado do painel ao vivo', () => {
  it('identifica o agente pelo clientInfo gravado no run', () => {
    expect(agentKind('{"client":"antigravity-client"}')).toBe('antigravity');
    expect(agentKind('{"client":"claude-code"}')).toBe('claude');
    expect(agentKind('{"client":"codex-mcp-client"}')).toBe('codex');
    expect(agentKind(null)).toBe('other');
  });

  it('plano aguardando aprovação vira pendência e fase ORDEM', () => {
    const run = store.startRun({ issueKey: 'FIX-1', env: ENV, mode: 'manual' });
    tick(); store.savePlan(run.id, [scenario('CT-001')]);
    const s = buildLiveState(db, { rootDir: root, now: clock });
    expect(s.runs[0]).toMatchObject({ id: run.id, agent: 'claude', phase: 2, waiting: true });
    expect(s.pending).toEqual([expect.objectContaining({ runId: run.id, kind: 'plan', scenarios: [expect.objectContaining({ code: 'CT-001' })] })]);
  });

  it('atividade em ordem: ação, verificação e conclusão; FAILED aparece no mapa', () => {
    const runId = executingRun();
    tick(); store.startScenario(runId, 'CT-001');
    tick(); store.recordAction(runId, 'CT-001', { action: 'fill', target: { role: 'textbox', name: 'Busca' }, guardLevel: 'GREEN', ok: true, valueSample: 'outros' });
    tick(); store.recordVerification(runId, 'CT-001', { kind: 'ui', description: 'lista filtrada', passed: false });
    tick(); store.recordVerification(runId, 'CT-001', { kind: 'ui', description: 'lista filtrada', passed: false });
    tick(); store.recordEvidence(runId, 'CT-001', { kind: 'screenshot', path: 'x.png' });
    store.logEvent(runId, store.getScenario(runId, 'CT-001').id, 'inspect.network', null);
    tick(); store.completeScenario(runId, 'CT-001', { status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'não filtrou' });

    const s = buildLiveState(db, { rootDir: root, now: clock });
    const r = s.runs[0]!;
    expect(r.phase).toBe(3);
    expect(r.scenarios.map((x) => x.status)).toEqual(['FAILED', 'PENDING']);
    const texts = r.feed.map((f) => f.text);
    expect(texts).toEqual(expect.arrayContaining(['CT-001 iniciado', 'CT-001 preencheu "Busca" = "outros"', 'CT-001 ✗ lista filtrada', 'CT-001 FAILED']));
    expect(texts.indexOf('CT-001 iniciado')).toBeLessThan(texts.indexOf('CT-001 FAILED'));
    expect(texts.some((t) => t.startsWith('tool.') || t.includes('inspect'))).toBe(false);
    expect(r.lastShot).not.toBeNull();
  });

  it('ação RED bloqueada sem resposta vira pendência; some depois da aprovação', () => {
    const runId = executingRun();
    tick(); store.startScenario(runId, 'CT-001');
    const sid = store.getScenario(runId, 'CT-001').id;
    tick(); store.recordAction(runId, 'CT-001', { action: 'click', target: { role: 'button', name: 'Remover' }, guardLevel: 'RED', ok: false, error: 'BLOQUEADO: ação RED exige aprovação humana' });
    store.logEvent(runId, sid, 'guard.block', { level: 'RED', reason: 'alvo contém "remover"', needsApproval: true });

    let s = buildLiveState(db, { rootDir: root, now: clock });
    expect(s.pending).toEqual([expect.objectContaining({ kind: 'red', title: 'Ação de risco: clicou em "Remover"' })]);

    tick(); store.recordApproval(runId, { action: 'click', target: 'button "Remover"', level: 'RED', justification: 'teste de remoção' });
    s = buildLiveState(db, { rootDir: root, now: clock });
    expect(s.pending).toEqual([]);
    expect(s.runs[0]!.decisions.map((d) => d.text)).toEqual(['Aprovou o plano (2 cenários)', 'Autorizou RED: clicou em button "Remover"']);
  });

  it('bug explicado no relatório aparece com a chave do Jira', () => {
    const runId = executingRun();
    store.logEvent(runId, null, 'report.explain', [{ code: 'CT-001', title: 'Remover envia o código', howToSee: 'a', happens: 'b', expected: 'c' }]);
    store.logEvent(runId, null, 'report.summaries', [{ code: 'CT-001', verdict: 'Falhou', text: 'não remove', jira: 'FIX-99' }]);
    const s = buildLiveState(db, { rootDir: root, now: clock });
    expect(s.bugs).toEqual([expect.objectContaining({ code: 'CT-001', jira: 'FIX-99', card: 'FIX-1' })]);
    expect(s.runs[0]!.bugs[0]).toMatchObject({ title: 'Remover envia o código', jira: 'FIX-99' });
  });

  it('bug confirmado conta uma vez: explicação sem confirmação e relatório repetido não somam', () => {
    const runId = executingRun();
    const explain = [{ code: 'CT-001', title: 'Divergência de texto', howToSee: 'a', happens: 'b', expected: 'c' }];
    store.logEvent(runId, null, 'report.explain', explain);
    const all = (sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as Record<string, unknown>[];
    expect(confirmedBugs(all).size).toBe(0);
    store.logEvent(runId, null, 'report.summaries', [{ code: 'CT-001', verdict: 'Falhou', text: 'x', jira: 'FIX-99' }]);
    store.logEvent(runId, null, 'report.explain', explain);
    store.logEvent(runId, null, 'report.summaries', [{ code: 'CT-001', verdict: 'Falhou', text: 'x', jira: 'FIX-99' }]);
    expect([...confirmedBugs(all).keys()]).toEqual([`${runId}:CT-001`]);
  });

  it('run ativo sem atividade mostra há quanto tempo está parado', () => {
    executingRun();
    expect(buildLiveState(db, { rootDir: root, now: clock }).runs[0]!.idleMinutes).toBe(0);
    const later = new Date(clock.getTime() + 14 * 3600_000);
    expect(buildLiveState(db, { rootDir: root, now: later }).runs[0]!.idleMinutes).toBe(14 * 60);
  });

  it('mostra só os runs das últimas 12 h (ou o último, se não houver nenhum)', () => {
    const runId = executingRun();
    store.abortRun(runId, 'teste');
    clock = new Date('2026-11-04T10:00:00Z');
    const s = buildLiveState(db, { rootDir: root, now: clock });
    expect(s.runs.map((r) => r.id)).toEqual([runId]);
    expect(s.runs[0]!.phase).toBe(5);
  });
});

describe('servidor do painel', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    const redactor = new Redactor({ secrets: [{ name: 'FIX_PASSWORD', value: SECRET }] });
    server = createLiveServer({ db, rootDir: root, redactor, now: () => clock });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const call = (path: string, opts: { method?: string; host?: string } = {}) => new Promise<{ status: number; body: string; type: string; frame?: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body, type: String(res.headers['content-type']), frame: res.headers['x-frame-options'] as string | undefined }));
    });
    req.on('error', reject);
    req.end();
  });

  it('serve a página e o estado redigido', async () => {
    const runId = executingRun();
    store.startScenario(runId, 'CT-001');
    store.recordAction(runId, 'CT-001', { action: 'fill', target: { role: 'textbox', name: 'Senha' }, guardLevel: 'GREEN', ok: true, valueSample: SECRET });
    const home = await call('/');
    expect(home.body).toContain('Central de QA');
    expect(home.frame).toBe('DENY'); // clickjacking (13/11)
    expect((await call('/jogo')).status).toBe(404);
    const state = await call('/api/state');
    expect(state.status).toBe(200);
    expect(state.body).toContain('FIX-1');
    expect(state.body).not.toContain(SECRET);

    const runData = await call(`/api/runs/${encodeURIComponent(runId)}`);
    expect(runData.status).toBe(200);
    expect(runData.body).toContain('FIX-1');
  });

  it('recusa Host de fora (DNS rebinding) e qualquer método além de GET', async () => {
    expect((await call('/api/state', { host: 'evil.example:80' })).status).toBe(403);
    expect((await call('/api/state', { method: 'POST' })).status).toBe(405);
  });

  it('serve evidência só de dentro de runs/ e relatório só de reports/', async () => {
    const runId = executingRun();
    mkdirSync(join(root, 'runs', 'FIX-1'), { recursive: true });
    writeFileSync(join(root, 'runs', 'FIX-1', 'a.png'), 'png');
    writeFileSync(join(root, 'segredo.png'), 'nao');
    const inside = store.recordEvidence(runId, null, { kind: 'screenshot', path: 'runs/FIX-1/a.png' });
    const escape = store.recordEvidence(runId, null, { kind: 'screenshot', path: 'runs/../segredo.png' });
    const notMedia = store.recordEvidence(runId, null, { kind: 'trace', path: 'runs/FIX-1/a.png.txt' });
    expect((await call(`/evidence/${inside}`)).type).toBe('image/png');
    expect((await call(`/evidence/${escape}`)).status).toBe(404);
    expect((await call(`/evidence/${notMedia}`)).status).toBe(404);
    // Caminho relativo usado pelo relatório HTML (../../runs/...).
    expect((await call('/runs/FIX-1/a.png')).type).toBe('image/png');
    expect((await call('/runs/%2E%2E/segredo.png')).status).toBe(404);
    expect((await call('/runs/..%5Csegredo.png')).status).toBe(404);
    writeFileSync(join(root, 'runs', 'FIX-1', 'notas.txt'), 'texto');
    expect((await call('/runs/FIX-1/notas.txt')).status).toBe(404);

    expect((await call(`/report/${runId}`)).status).toBe(404);
    mkdirSync(join(root, 'reports', 'FIX-1'), { recursive: true });
    writeFileSync(join(root, 'reports', 'FIX-1', `${runId}.html`), '<p>relatório</p>');
    expect((await call(`/report/${runId}`)).body).toBe('<p>relatório</p>');
    expect((await call('/report/..%2F..%2Fsegredo')).status).toBe(404);
  });
});

describe('consumo do plano', () => {
  const line = (id: string, ts: string, output: number) => JSON.stringify({
    type: 'assistant', sessionId: 's1', timestamp: ts,
    message: { id, model: 'm', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 } },
  });

  it('soma tokens por janela, lê só o que foi acrescentado e usa a % gravada pela linha de status', async () => {
    const { appendFileSync } = await import('node:fs');
    const { UsageMeter } = await import('../src/live/usage.ts');
    const projects = join(root, 'projects', 'p1');
    mkdirSync(projects, { recursive: true });
    const file = join(projects, 'a.jsonl');
    const now = new Date('2026-11-03T12:00:00Z');
    writeFileSync(file, [line('old', '2026-11-03T05:00:00Z', 5), line('m1', '2026-11-03T11:00:00Z', 20), line('m1', '2026-11-03T11:00:00Z', 40)].join('\n') + '\n');
    const limits = join(root, 'usage-limits.json');
    writeFileSync(limits, JSON.stringify({
      five_hour: { used_percentage: 23.5, resets_at: Date.parse('2026-11-03T14:00:00Z') / 1000 },
      seven_day: { used_percentage: 41, resets_at: Date.parse('2026-11-03T11:00:00Z') / 1000 }, // já renovou
    }));
    let clockNow = now;
    const meter = new UsageMeter({ claudeProjectsDir: join(root, 'projects'), claudeLimitsFile: limits, codexSessionsDir: join(root, 'codex') }, () => clockNow, 0);
    const claude = () => meter.state().agents.find((a) => a.agent === 'claude')!;

    let u = claude();
    expect(u.fiveHour).toMatchObject({ usedPct: 23.5, calls: 1, spent: 10 + 100 + 40, cacheRead: 1000 });
    expect(u.sevenDay).toMatchObject({ usedPct: null, resetsAt: null, renewedAt: '2026-11-03T11:00:00.000Z', calls: 2, spent: 150 + 115 });

    // Linha incompleta no fim do arquivo fica para a próxima leitura.
    appendFileSync(file, line('m2', '2026-11-03T11:30:00Z', 7).slice(0, 30));
    expect(claude().fiveHour.calls).toBe(1);
    appendFileSync(file, line('m2', '2026-11-03T11:30:00Z', 7).slice(30) + '\n');
    clockNow = new Date(now.getTime() + 1000);
    u = claude();
    expect(u.fiveHour).toMatchObject({ calls: 2, spent: 150 + 117 });
    expect(meter.state().agents.find((a) => a.agent === 'antigravity')).toMatchObject({ available: false });
  });

  it('Codex: tokens por token_count (sem repetir evento) e a % do rate_limits mais recente', async () => {
    const { UsageMeter } = await import('../src/live/usage.ts');
    const dir = join(root, 'codex', '2026', '11', '03');
    mkdirSync(dir, { recursive: true });
    const ev = (ts: string, total: number, used5: number) => JSON.stringify({
      timestamp: ts, type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 20 } },
        rate_limits: { primary: { used_percent: used5, window_minutes: 300, resets_at: Date.parse('2026-11-03T15:00:00Z') / 1000 }, secondary: { used_percent: 42, window_minutes: 10080, resets_at: Date.parse('2026-11-08T00:00:00Z') / 1000 } },
      },
    });
    writeFileSync(join(dir, 'rollout-a.jsonl'), [ev('2026-11-03T10:00:00Z', 1020, 20), ev('2026-11-03T10:00:00Z', 1020, 20), ev('2026-11-03T11:00:00Z', 2040, 23), '{"type":"other"}'].join('\n') + '\n');
    const meter = new UsageMeter({ claudeProjectsDir: join(root, 'nada'), claudeLimitsFile: join(root, 'nada.json'), codexSessionsDir: join(root, 'codex') }, () => new Date('2026-11-03T12:00:00Z'), 0);
    const codex = meter.state().agents.find((a) => a.agent === 'codex')!;
    expect(codex.fiveHour).toMatchObject({ usedPct: 23, calls: 2, spent: 2 * (100 + 20), cacheRead: 1800 });
    expect(codex.sevenDay).toMatchObject({ usedPct: 42, resetsAt: '2026-11-08T00:00:00.000Z' });
    // Reset da janela de 5 h passou sem registro novo: Codex grava a % a cada uso, então está zerada.
    const later = new UsageMeter({ claudeProjectsDir: join(root, 'nada'), claudeLimitsFile: join(root, 'nada.json'), codexSessionsDir: join(root, 'codex') }, () => new Date('2026-11-03T16:00:00Z'), 0);
    expect(later.state().agents.find((a) => a.agent === 'codex')!.fiveHour).toMatchObject({ usedPct: 0, resetsAt: null, renewedAt: '2026-11-03T15:00:00.000Z' });
  });
});
