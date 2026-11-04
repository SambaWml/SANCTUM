import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { buildLiveState } from '../src/live/state.ts';
import { openDb } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';

/**
 * Roda o script da página da Central de Caça com um DOM falso e um estado real do banco: qualquer
 * erro de desenho (variável inexistente, campo que mudou de nome) aparece aqui, não na tela do
 * usuário como "sem conexão".
 */
const config = loadConfig(join(import.meta.dirname, '..'));
const PAGE = readFileSync(join(import.meta.dirname, '..', 'src', 'live', 'page.html'), 'utf8');

function fakeElement(): unknown {
  const t: Record<string, unknown> = {
    style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    innerHTML: '', textContent: '', value: '', className: '', offsetLeft: 0, offsetTop: 0, offsetWidth: 10, offsetHeight: 10, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
  };
  return new Proxy(t, {
    get(o, k) {
      if (k in o) return o[k as string];
      if (k === 'querySelectorAll') return () => [];
      if (k === 'lastElementChild' || k === 'firstChild' || k === 'parentElement') return fakeElement();
      return typeof k === 'string' ? () => fakeElement() : undefined;
    },
    set(o, k, v) { o[k as string] = v; return true; },
  });
}

async function renderErrors(state: unknown): Promise<string[]> {
  const errors: string[] = [];
  const src = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
  let calls = 0;
  const fetch = async () => (++calls > 1 ? new Promise(() => {}) : { ok: true, json: async () => state });
  const document = { getElementById: () => fakeElement(), querySelector: () => fakeElement(), querySelectorAll: () => [], addEventListener() {}, body: fakeElement(), createElement: () => fakeElement(), title: '' };
  const run = new Function('document', 'window', 'localStorage', 'fetch', 'console', 'setTimeout', 'clearTimeout', 'navigator', 'Notification', 'confirm', 'alert', src);
  try {
    run(document, { addEventListener() {}, location: { href: '' } }, { getItem: () => null, setItem() {} }, fetch,
      { error: (...a: unknown[]) => errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')), log() {}, warn() {} },
      () => 0, () => {}, { clipboard: {} }, { permission: 'default', requestPermission: async () => 'default' }, () => false, () => {});
  } catch (e) {
    errors.push(`carga: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 50));
  return errors;
}

describe('página da Central de Caça', () => {
  it('desenha sem erro com runs, missões e consumo', async () => {
    const db = openDb(':memory:');
    const store = new StateStore(db, config, { now: () => new Date() });
    store.agent = { client: 'claude-code' };
    const run = store.startRun({ issueKey: 'FIX-1', env: 'fixture-local', mode: 'manual' });
    store.savePlan(run.id, [{ code: 'CT-001', title: 'Login válido', priority: 'P1', risk: 'HIGH', types: ['functional'], steps: ['logar'], expected: 'dashboard' }]);
    store.approvePlan(run.id);
    store.startScenario(run.id, 'CT-001');
    const state = {
      ...buildLiveState(db, { rootDir: '/x' }),
      usage: { agents: [{ agent: 'claude', available: true, fiveHour: { usedPct: 40, resetsAt: new Date(Date.now() + 3600_000).toISOString(), renewedAt: null, spent: 1000, cacheRead: 10, calls: 2 }, sevenDay: { usedPct: null, resetsAt: null, renewedAt: null, spent: 0, cacheRead: 0, calls: 0 }, limitsUpdatedAt: null }] },
      missions: [{ id: 'M-1', agent: 'antigravity', target: 'FIX-1', kind: 'qa', objective: null, status: 'WAITING', session_id: 's', pid: null, last_message: 'Aprova?', error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), log_path: null, run_id: run.id, archived_at: null, runId: run.id, runStatus: 'EXECUTING', activity: [{ ts: new Date().toISOString(), text: '→ run_start' }] }],
      prompts: [{ id: 1, mission_id: 'M-1', kind: 'permission', tool: 'mcp(novo-qa/jira_create_issue)', summary: 'Criar Sub-bug', input_json: '{"a":1}', status: 'PENDING', decision: null, message: null, created_at: new Date().toISOString(), answered_at: null }],
    };
    expect(await renderErrors(state)).toEqual([]);
  });
});
