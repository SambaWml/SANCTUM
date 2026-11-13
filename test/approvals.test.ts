import { EventEmitter } from 'node:events';
import { mkdtempSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isForbiddenRule, isProtectedPath } from '../src/live/agents.ts';
import { MissionManager } from '../src/live/missions.ts';
import { answerPrompt, consumeGrant, decidePermission, pendingPrompts } from '../src/live/prompts.ts';
import { Redactor } from '../src/security/redact.ts';
import { openDb, type Db } from '../src/state/db.ts';

/**
 * Aprovações pelo painel (auditoria de 09/11): cada "Permitir" vale para uma ação, concessão que
 * sobra expira no fim do turno, resposta em texto não aprova nada, e terminal/arquivos do Sanctum
 * são proibidos sempre — nem chegam a virar pedido.
 */

let db: Db;
const redactor = new Redactor();
beforeEach(() => { db = openDb(':memory:'); });

function fakeSpawn(script: (call: number) => unknown[]) {
  const calls: { args: string[] }[] = [];
  const spawnFn = ((_bin: string, args: string[], opts: { stdio: [unknown, number, number] }) => {
    calls.push({ args });
    for (const l of script(calls.length)) writeSync(opts.stdio[1], `${JSON.stringify(l)}\n`);
    return Object.assign(new EventEmitter(), { pid: 2000 + calls.length, unref() {} });
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnFn, calls };
}
const manager = (spawnFn: typeof import('node:child_process').spawn) =>
  new MissionManager({ db, rootDir: '/x', logDir: mkdtempSync(join(tmpdir(), 'sanctum-ap-')), spawnFn, killTree: () => {}, isAlive: () => false });

const init = { event: 'init', conversation_id: 'conv-1' };
const result = (response = '') => ({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response } });
const denied = (rule: string, params: unknown = {}) => ({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_name: 'call_mcp_tool',
  tool_info: { parameters: params, error: { message: `permission check failed: user denied permission for ${rule}\nDo not attempt to circumvent` } } } });
// Formatos reais do agy: terminal negado (run_command) e a lista genérica no resultado do turno.
const shellDenied = (cmd: string) => ({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_name: 'run_command',
  tool_info: { parameters: { CommandLine: cmd }, error: { message: `permission check failed for unsandboxed "${cmd}": user denied permission to run command:\n${cmd}` } } } });
const resultDenied = (actions: string[]) => ({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: '', denied_actions: actions.map((action) => ({ action })) } });
const settings = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]!) as { permissions: { allow: string[] } };
const prompt = (args: string[]) => args[args.indexOf('-p') + 1]!;

describe('concessão de uso único', () => {
  it('um "Permitir" no Jira vale para uma ação, e a que sobra expira no fim do turno', () => {
    const { spawnFn } = fakeSpawn((n) => n === 1 ? [init, denied('mcp(sanctum/jira_comment)', { ToolName: 'jira_comment', Arguments: { issueKey: 'FIX-1', body: 'ok' } }), result()] : [init, result('Comentei.')]);
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'FIX-1' }, kind: 'qa' });
    missions.poll();
    answerPrompt(db, pendingPrompts(db)[0]!.id, 'allow', undefined);
    missions.poll(); // continua o turno com a regra liberada e cria a concessão
    const grants = db.prepare(`SELECT COUNT(*) n FROM prompts WHERE mission_id = ? AND kind = 'plan' AND tool = 'jira_comment'`).get(m.id) as { n: number };
    expect(grants.n).toBe(1);
    missions.poll(); // turno termina sem usar a concessão
    expect(consumeGrant(db, m.id, 'jira_comment')).toBe(false);
    expect(missions.get(m.id).status).not.toBe('RUNNING');
  });
});

describe('negação genérica', () => {
  it('"mcp" genérico do resultado do turno não vira pedido quando a negação exata já veio', () => {
    const { spawnFn } = fakeSpawn(() => [init, denied('mcp(sanctum/jira_comment)', { ToolName: 'jira_comment', Arguments: { issueKey: 'FIX-5', body: 'x' } }), resultDenied(['mcp'])]);
    const missions = manager(spawnFn);
    missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'FIX-5' }, kind: 'qa' });
    missions.poll();
    expect(pendingPrompts(db).map((p) => p.tool)).toEqual(['mcp(sanctum/jira_comment)']);
  });
});

describe('resposta em texto não aprova', () => {
  it('responder "ok" com permissão pendente expira o pedido em vez de liberar a ação', () => {
    const { spawnFn, calls } = fakeSpawn((n) => n === 1 ? [init, denied('mcp(sanctum/act_approved)', { ToolName: 'act_approved', Arguments: { action: 'click', target: { name: 'Remover' } } }), result()] : [init, result('Certo.')]);
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'FIX-2' }, kind: 'qa' });
    missions.poll();
    expect(pendingPrompts(db)).toHaveLength(1);
    missions.reply(m.id, 'ok, pode continuar');
    expect(pendingPrompts(db)).toHaveLength(0);
    expect(settings(calls[1]!.args).permissions.allow).not.toContain('mcp(sanctum/act_approved)');
    expect(consumeGrant(db, m.id, 'act_approved')).toBe(false);
  });
});

describe('proibido sempre: terminal e arquivos do Sanctum', () => {
  it('terminal ("shell") e escrita em src/ não viram pedido; cadastro em config/ vira', () => {
    const { spawnFn, calls } = fakeSpawn((n) => n === 1
      ? [init, shellDenied('dir src'), denied('write_file(C:/Users/wesml/NEW QA/src/browser/target.ts)'), denied('write_file(C:/Users/wesml/NEW QA/config/environments.yaml)'), resultDenied(['command', 'write_file', 'write_file'])]
      : [init, result()]);
    const missions = manager(spawnFn);
    missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'FIX-3' }, kind: 'qa' });
    missions.poll();
    expect(pendingPrompts(db).map((p) => p.tool)).toEqual(['write_file(C:/Users/wesml/NEW QA/config/environments.yaml)']);
    expect(calls).toHaveLength(1);
  });

  it('só proibido: segue com o aviso, sem perguntar', () => {
    const { spawnFn, calls } = fakeSpawn((n) => n === 1 ? [init, shellDenied('git grep token'), resultDenied(['command'])] : [init, result('Ok, sem terminal.')]);
    const missions = manager(spawnFn);
    missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'FIX-4' }, kind: 'qa' });
    missions.poll();
    expect(pendingPrompts(db)).toEqual([]);
    expect(prompt(calls[1]!.args)).toMatch(/O Sanctum proíbe: shell/);
    expect(pendingPrompts(db).some((p) => p.tool === 'shell' || p.tool === 'command')).toBe(false);
  });

  it('Claude pelo painel: terminal e edição do Sanctum negados sem pedido; relatório em reports/ pede', async () => {
    db.prepare(`INSERT INTO missions (id, agent, target, kind, status, created_at, updated_at) VALUES ('M-1', 'claude', 'FIX-1', 'qa', 'RUNNING', 'x', 'x')`).run();
    const deps = { db, redactor, missionId: 'M-1', pollMs: 1, timeoutMs: 5 };
    expect(await decidePermission(deps, 'Bash', { command: 'git grep token' })).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/proibido/) });
    expect(await decidePermission(deps, 'Edit', { file_path: 'C:\\Users\\wesml\\NEW QA\\src\\live\\missions.ts' })).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/proibido/) });
    expect(pendingPrompts(db)).toEqual([]);
    await decidePermission(deps, 'Write', { file_path: 'C:\\Users\\wesml\\NEW QA\\reports\\FIX-1\\resumo.md', content: 'x' });
    expect(db.prepare(`SELECT tool FROM prompts`).all()).toEqual([{ tool: 'Write' }]);
  });

  it('o que conta como arquivo do Sanctum', () => {
    for (const p of ['C:/Users/wesml/NEW QA/src/live/panel.html', 'C:\\Users\\wesml\\NEW QA\\.claude\\settings.json', '.mcp.json', 'AGENTS.md', 'config/qa-policy.yaml', 'test/x.test.ts', 'package.json']) {
      expect(isProtectedPath(p)).toBe(true);
    }
    for (const p of ['config/environments.yaml', 'reports/FIX-1/a.md', 'runs/_evidencias/x.png', 'knowledge/guruja/modules/meta.yaml']) {
      expect(isProtectedPath(p)).toBe(false);
    }
    expect(isForbiddenRule('run_command(dir)')).toBe(true);
    expect(isForbiddenRule('mcp(sanctum/jira_comment)')).toBe(false);
    // edit_file do Antigravity também é escrita (13/11) e a espera agendada nunca é liberada.
    expect(isForbiddenRule('edit_file(src/state/store.ts)')).toBe(true);
    expect(isForbiddenRule('edit_file(runs/notas.md)')).toBe(false);
    expect(isForbiddenRule('schedule')).toBe(true);
  });
});
