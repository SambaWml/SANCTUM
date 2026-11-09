import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { createServer } from '../src/mcp/server.ts';
import { createRegistrar } from '../src/mcp/tooling.ts';
import { Redactor } from '../src/security/redact.ts';
import { openDb } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';

const root = join(import.meta.dirname, '..');
const hook = join(root, '.codex', 'hooks', 'guard-shell.mjs');

describe('hook Codex', () => {
  it.each([
    { command: 'curl -X DELETE https://example.invalid/api/1' },
    { cmd: `node -e "require('playwright').chromium.launch()"` },
    { commands: ['git status', 'Invoke-RestMethod -Uri https://x/api/1 -Method Delete'] },
    { chars: 'curl -X DELETE https://example.invalid/api/1\n' },
  ])('bloqueia bypass na entrada %j', async (tool_input) => {
    const { checkInput } = await import(pathToFileURL(hook).href);
    expect(checkInput({ cwd: root, tool_input })).toMatch(/Action Guard/);
  });

  it('permite desenvolvimento e devolve bloqueio no protocolo real do Codex', () => {
    const allowed = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { cmd: 'npm run typecheck' } }), encoding: 'utf8' });
    expect(allowed.status).toBe(0);
    const blocked = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command: 'curl -X DELETE https://x/api/1' } }), encoding: 'utf8' });
    expect(blocked.status).toBe(2);
    expect(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(spawnSync(process.execPath, [hook], { input: '{invalid', encoding: 'utf8' }).status).toBe(2);
  });

  it('carrega a configuração do hook e encontra os roteiros referenciados pelas skills', () => {
    const hooks = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')).hooks.PreToolUse;
    expect(hooks).toHaveLength(1);
    const blocked = spawnSync(hooks[0].hooks[0].command, {
      shell: true, cwd: tmpdir(), encoding: 'utf8',
      input: JSON.stringify({ tool_input: { command: 'curl -X DELETE https://x/api/1' } }),
    });
    expect(blocked.status).toBe(2);
    expect(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    for (const name of ['qa', 'qa-resume', 'retest', 'automate']) {
      const dir = join(root, '.agents', 'skills', name);
      const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        expect(readFileSync(join(dir, match[1]!.split('#')[0]!), 'utf8').length).toBeGreaterThan(0);
      }
    }
  });
});

describe('aprovação humana Codex via MCP', () => {
  it('inicializa pelo launcher real em stdio e bloqueia aprovação sem confirmação no cliente', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanctum-codex-stdio-'));
    const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
    const client = new Client({ name: 'codex-stdio-test', version: '0' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'src/mcp/launcher.ts'], cwd: root, stderr: 'pipe',
      env: { ...env, SANCTUM_CLIENT: 'codex', SANCTUM_DB: join(dir, 'state.db'), SANCTUM_WATCH_DIR: dir, SANCTUM_BROWSER_LOCK: join(dir, 'browser.lock') },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['plan_approve', 'act_approved', 'browser_open', 'verify', 'report_build']));
      // Mesmo sem run válido, a confirmação deve bloquear antes de alcançar o handler.
      const result = await client.callTool({ name: 'plan_approve', arguments: { runId: 'isolated-test' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('confirmação humana indisponível');
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  async function session(response?: ElicitResult) {
    const db = openDb(':memory:');
    const store = new StateStore(db, loadConfig(root));
    const redactor = new Redactor();
    const server = createServer({ store, redactor, rootDir: root, requireHumanApproval: true });
    // A mesma proteção do registrar deve valer antes do handler de ações RED.
    let actions = 0;
    createRegistrar(server, { store, redactor, requireHumanApproval: true })('act_approved', 'Ação RED de teste', {}, () => ({ actions: ++actions }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'codex-test', version: '0' }, { capabilities: response ? { elicitation: { form: {} } } : {} });
    if (response) client.setRequestHandler(ElicitRequestSchema, async () => response);
    await client.connect(a);
    const run = store.startRun({ issueKey: 'FIX-900', env: 'fixture-local', mode: 'manual' });
    store.savePlan(run.id, [{ code: 'CT-001', title: 'Exemplo', priority: 'P1', risk: 'LOW', types: [], steps: ['x'], expected: 'yyy' }]);
    return { client, store, runId: run.id, actions: () => actions, close: async () => { await client.close(); await server.close(); db.close(); } };
  }

  it.each([
    undefined,
    { action: 'cancel' },
    { action: 'decline' },
    { action: 'accept', content: { confirm: false } },
  ] satisfies (ElicitResult | undefined)[])('sem confirmação %j não aprova plano nem executa ação RED', async (response) => {
    const h = await session(response);
    try {
      expect((await h.client.callTool({ name: 'plan_approve', arguments: { runId: h.runId } })).isError).toBe(true);
      expect(h.store.getRun(h.runId).status).toBe('AWAITING_APPROVAL');
      expect((await h.client.callTool({ name: 'act_approved', arguments: {} })).isError).toBe(true);
      expect(h.actions()).toBe(0);
    } finally { await h.close(); }
  });

  it('aceite explícito aprova plano e permite ação RED', async () => {
    const h = await session({ action: 'accept', content: { confirm: true } });
    try {
      expect((await h.client.callTool({ name: 'plan_approve', arguments: { runId: h.runId } })).isError).not.toBe(true);
      expect(h.store.getRun(h.runId).status).toBe('EXECUTING');
      expect((await h.client.callTool({ name: 'act_approved', arguments: {} })).isError).not.toBe(true);
      expect(h.actions()).toBe(1);
    } finally { await h.close(); }
  });
});
