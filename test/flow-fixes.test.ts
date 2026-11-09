import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeTarget } from '../src/browser/target.ts';
import { loadConfig } from '../src/config/load.ts';
import { MissionManager } from '../src/live/missions.ts';
import { createServer } from '../src/mcp/server.ts';
import { Redactor } from '../src/security/redact.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { LOOP_LIMITS, StateStore, type ScenarioInput } from '../src/state/store.ts';

/** Correções da auditoria de fluxo (09/11). */

const config = loadConfig(join(import.meta.dirname, '..'));
const scenario = (code: string): ScenarioInput => ({ code, title: `Cenário ${code}`, priority: 'P1', risk: 'HIGH', types: ['functional'], steps: ['passo'], expected: 'resultado' });

let db: Db;
let store: StateStore;
beforeEach(() => {
  db = openDb(':memory:');
  store = new StateStore(db, config);
});

function executing(): string {
  const run = store.startRun({ issueKey: 'FIX-1', env: 'fixture-local', mode: 'manual' });
  store.savePlan(run.id, [scenario('CT-001'), scenario('CT-002')]);
  store.approvePlan(run.id);
  return run.id;
}

describe('botões do painel passam pelo core', () => {
  it('parar a missão aborta o run com motivo e registra o dado de teste que ficou', () => {
    const runId = executing();
    store.addCreatedCandidate(runId, null, 'POST /api/alunos', '42');
    const spawnFn = (() => Object.assign(new EventEmitter(), { pid: 99, unref() {} })) as unknown as typeof import('node:child_process').spawn;
    const missions = new MissionManager({ db, rootDir: '/x', logDir: mkdtempSync(join(tmpdir(), 'sanctum-ff-')), spawnFn, killTree: () => {}, isAlive: () => true });
    const m = missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-1' }, kind: 'qa' });
    db.prepare('UPDATE missions SET run_id = ? WHERE id = ?').run(runId, m.id);
    missions.stop(m.id);
    expect(store.getRun(runId)).toMatchObject({ status: 'ABORTED', summary: 'missão parada pelo usuário no painel' });
    const abort = db.prepare(`SELECT payload FROM events WHERE run_id = ? AND type = 'run.abort'`).get(runId) as { payload: string };
    expect(JSON.parse(abort.payload).pendingData.join(' ')).toMatch(/POST \/api\/alunos \(42\)/);
  });
});

describe('cenário andando em círculo', () => {
  it('avisa a partir do limite de aviso, trava no limite de parada e marca o run uma vez por nível', () => {
    const runId = executing();
    const s = store.startScenario(runId, 'CT-001');
    const act = (n: number) => { for (let i = 0; i < n; i++) store.recordAction(runId, 'CT-001', { action: 'click', target: { role: 'button', name: 'Salvar' }, guardLevel: 'GREEN', ok: true }); };
    act(LOOP_LIMITS.warn.actions - 1);
    expect(store.scenarioLoad(s.id).level).toBe('ok');
    act(1);
    expect(store.scenarioLoad(s.id).level).toBe('warn');
    store.scenarioLoad(s.id);
    act(LOOP_LIMITS.stop.actions - LOOP_LIMITS.warn.actions);
    expect(store.scenarioLoad(s.id)).toMatchObject({ level: 'stop', actions: LOOP_LIMITS.stop.actions });
    const marks = db.prepare(`SELECT json_extract(payload, '$.level') l FROM events WHERE scenario_id = ? AND type = 'scenario.loop' ORDER BY id`).all(s.id) as { l: string }[];
    expect(marks.map((m) => m.l)).toEqual(['warn', 'stop']);
  });

  it('reabrir o cenário zera a contagem (nova tentativa)', () => {
    const runId = executing();
    const s = store.startScenario(runId, 'CT-001');
    for (let i = 0; i < LOOP_LIMITS.warn.actions; i++) store.recordAction(runId, 'CT-001', { action: 'click', target: { role: 'button', name: 'x' }, guardLevel: 'GREEN', ok: true });
    store.completeScenario(runId, 'CT-001', { status: 'NEEDS_REVIEW', reason: 'repetindo' });
    store.reopenScenario(runId, 'CT-001', 'tentar por outro caminho');
    store.startScenario(runId, 'CT-001');
    expect(store.scenarioLoad(s.id).level).toBe('ok');
  });
});

describe('registro e ferramentas mais claros', () => {
  it('a recusa de regra fica no evento com o motivo inteiro, não só a 1ª linha', async () => {
    const server = createServer({ store, redactor: new Redactor(), rootDir: join(import.meta.dirname, '..'), config, db });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'teste', version: '1' });
    await client.connect(a);
    const runId = executing();
    store.startScenario(runId, 'CT-001');
    await client.callTool({ name: 'scenario_complete', arguments: { runId, code: 'CT-001', status: 'PASSED' } });
    const ev = db.prepare(`SELECT json_extract(payload, '$.error') e FROM events WHERE type = 'tool.scenario_complete' ORDER BY id DESC LIMIT 1`).get() as { e: string };
    expect(ev.e).toMatch(/não pode ser PASSED: \| - PASSED exige ao menos 1 verificação aprovada/);
  });

  it('role + text vira role + name (erro comum, sem ambiguidade)', () => {
    expect(normalizeTarget({ role: 'button', text: 'Salvar' })).toEqual({ role: 'button', name: 'Salvar' });
    expect(normalizeTarget({ role: 'button', name: 'Salvar' })).toEqual({ role: 'button', name: 'Salvar' });
    expect(normalizeTarget({ text: 'Salvar' })).toEqual({ text: 'Salvar' });
  });

  it('fechar cenário com o run já fechado diz o que fazer', () => {
    const runId = executing();
    for (const code of ['CT-001', 'CT-002']) store.completeScenario(runId, code, { status: 'NOT_EXECUTED', reason: 'teste' });
    store.completeRun(runId, 'INCONCLUSIVO', 'resumo');
    expect(() => store.startScenario(runId, 'CT-001')).toThrow(/scenario_reclassify/);
  });
});
