import { EventEmitter } from 'node:events';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { ALLOWED_TOOLS, MissionManager } from '../src/live/missions.ts';
import { answerPrompt, decidePermission, describeTool, pendingPrompts } from '../src/live/prompts.ts';
import { createLiveServer } from '../src/live/server.ts';
import { buildLiveState } from '../src/live/state.ts';
import { Redactor } from '../src/security/redact.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';

const config = loadConfig(join(import.meta.dirname, '..'));
const SECRET = 'S3nh@-Muito-Secreta-42';

/** Processo falso do Claude Code: escreve o stream-json no arquivo de saída do turno e registra os argumentos. */
function fakeSpawn(script: (call: number) => { lines: unknown[]; stderr?: string }) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; detached: boolean }[] = [];
  const spawnFn = ((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; detached: boolean; stdio: [unknown, number, number] }) => {
    calls.push({ args, env: opts.env, detached: opts.detached });
    const { lines, stderr } = script(calls.length);
    for (const l of lines) writeSync(opts.stdio[1], `${JSON.stringify(l)}\n`);
    if (stderr) writeSync(opts.stdio[2], stderr);
    return Object.assign(new EventEmitter(), { pid: 1000 + calls.length, unref() {} });
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnFn, calls };
}
/** Gerente com saída numa pasta temporária; por padrão o processo do turno já terminou. */
const manager = (spawnFn: typeof import('node:child_process').spawn, extra: Partial<ConstructorParameters<typeof MissionManager>[0]> = {}) =>
  new MissionManager({ db, rootDir: '/x', logDir: mkdtempSync(join(tmpdir(), 'novo-qa-ml-')), spawnFn, killTree: () => {}, isAlive: () => false, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 20));

let db: Db;
let redactor: Redactor;

beforeEach(() => {
  db = openDb(':memory:');
  redactor = new Redactor({ secrets: [{ name: 'FIX_PASSWORD', value: SECRET }] });
});

describe('missões do painel', () => {
  it('lança o Claude com a skill, guarda a sessão e fica esperando a resposta', async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({
      lines: [
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__novo-qa__run_start' }, { type: 'text', text: 'Plano pronto.\nAprova?' }] } },
        { type: 'result', subtype: 'success', result: 'Plano pronto. Aprova?', session_id: 'sess-1' },
      ],
    }));
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-1' }, kind: 'explore', objective: 'foco no cadastro' });
    expect(m.status).toBe('RUNNING');
    missions.poll();

    const args = calls[0]!.args;
    expect(calls[0]!.detached).toBe(true);
    expect(args[args.indexOf('-p') + 1]).toBe('/qa FIX-1 --explore foco no cadastro');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__novo-qa__permission_prompt');
    expect(args[args.indexOf('--allowedTools') + 1]).not.toMatch(/plan_approve|act_approved/);
    expect(calls[0]!.env.NOVO_QA_MISSION).toBe(m.id);
    const view = missions.list()[0]!;
    expect(view).toMatchObject({ status: 'WAITING', session_id: 'sess-1', last_message: 'Plano pronto. Aprova?' });
    expect(view.activity.map((a) => a.text)).toEqual(['→ run_start', 'Plano pronto.', 'esperando você']);
  });

  it('aprovar o plano pelo painel continua a conversa e libera o plan_approve sem perguntar de novo', async () => {
    const { spawnFn, calls } = fakeSpawn((n) => ({ lines: [{ type: 'system', session_id: 'sess-1' }, { type: 'result', result: n === 1 ? 'Aprova?' : 'Executando.', session_id: 'sess-1' }] }));
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'claude', target: { kind: 'url', url: 'https://app.exemplo.com/' }, kind: 'explore' });
    missions.poll();
    expect(calls[0]!.args).toContain('/qa https://app.exemplo.com/ --explore');

    missions.reply(m.id, '', { approvePlan: true });
    missions.poll();
    const resume = calls[1]!.args;
    expect(resume[resume.indexOf('--resume') + 1]).toBe('sess-1');
    expect(resume[resume.indexOf('-p') + 1]).toBe('Plano aprovado. Pode seguir.');
    expect(missions.get(m.id).last_message).toBe('Executando.');

    const first = await decidePermission({ db, redactor, missionId: m.id }, 'mcp__novo-qa__plan_approve', { runId: 'R1' });
    expect(first).toEqual({ behavior: 'allow', updatedInput: { runId: 'R1' } });
    // A aprovação vale uma vez: o próximo plan_approve volta a pedir.
    const again = decidePermission({ db, redactor, missionId: m.id, pollMs: 1, timeoutMs: 50 }, 'mcp__novo-qa__plan_approve', { runId: 'R1' });
    await settle();
    expect(pendingPrompts(db)).toHaveLength(1);
    expect(await again).toMatchObject({ behavior: 'deny' });
  });

  it('não deixa responder enquanto o agente trabalha nem lançar duas vezes o mesmo alvo', () => {
    const { spawnFn } = fakeSpawn(() => ({ lines: [] }));
    const missions = manager(spawnFn, { isAlive: () => true });
    const m = missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-1' }, kind: 'qa' });
    missions.poll();
    expect(() => missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-1' }, kind: 'qa' })).toThrow(/já existe a missão/);
    expect(() => missions.reply(m.id, 'oi')).toThrow(/ainda está trabalhando/);
    expect(() => missions.launch({ agent: 'claude', target: { kind: 'url', url: 'https://a.b/' }, kind: 'retest' })).toThrow(/exigem um card/);
  });

  it('painel reiniciado continua acompanhando o turno que seguiu rodando', () => {
    let alive = true;
    const { spawnFn } = fakeSpawn(() => ({ lines: [{ type: 'system', session_id: 's' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Lendo o card.' }] } }] }));
    const logDir = mkdtempSync(join(tmpdir(), 'novo-qa-ml-'));
    const first = manager(spawnFn, { logDir, isAlive: () => alive });
    const m = first.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-6' }, kind: 'qa' });
    first.poll();

    // Painel novo: nada em memória, o processo do agente ainda vivo e escrevendo.
    const second = manager(spawnFn, { logDir, isAlive: () => alive });
    second.recover();
    second.poll();
    expect(second.get(m.id).status).toBe('RUNNING');
    expect(second.list()[0]!.activity.map((a) => a.text)).toEqual(['Lendo o card.']);
    writeFileSync(second.get(m.id).log_path!, `${JSON.stringify({ type: 'result', result: 'Plano pronto. Aprova?', session_id: 's' })}\n`, { flag: 'a' });
    alive = false;
    second.poll();
    expect(second.get(m.id)).toMatchObject({ status: 'WAITING', last_message: 'Plano pronto. Aprova?' });
  });

  it('parar mata a árvore do processo e expira os pedidos pendentes', async () => {
    const killed: number[] = [];
    const { spawnFn } = fakeSpawn(() => ({ lines: [] }));
    const missions = manager(spawnFn, { isAlive: () => true, killTree: (pid) => killed.push(pid) });
    const m = missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-2' }, kind: 'qa' });
    const pending = decidePermission({ db, redactor, missionId: m.id, pollMs: 1, timeoutMs: 1000 }, 'Bash', { command: 'npm test' });
    await settle();
    expect(missions.stop(m.id).status).toBe('STOPPED');
    expect(killed).toEqual([1001]);
    expect(await pending).toMatchObject({ behavior: 'deny' });
  });

  it('turno que falhou mostra o erro (resultado de erro ou só stderr)', () => {
    const { spawnFn } = fakeSpawn((n) => (n === 1
      ? { lines: [{ type: 'result', is_error: true, result: 'limite de uso atingido' }] }
      : { lines: [], stderr: 'claude: comando não encontrado' }));
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-3' }, kind: 'qa' });
    missions.poll();
    expect(missions.get(m.id)).toMatchObject({ status: 'FAILED', error: 'limite de uso atingido' });
    const n = missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-7' }, kind: 'qa' });
    missions.poll();
    expect(missions.get(n.id)).toMatchObject({ status: 'FAILED', error: 'claude: comando não encontrado' });
  });

  it('grava o uso do plano informado pelo agente para o medidor do painel', async () => {
    const { readFileSync } = await import('node:fs');
    const limitsFile = join(mkdtempSync(join(tmpdir(), 'novo-qa-lim-')), 'usage-limits.json');
    const { spawnFn } = fakeSpawn(() => ({ lines: [
      { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.58, resetsAt: 1793722800 }, seven_day: { utilization: 0.78, resetsAt: 1794045600 } } } },
      { type: 'result', result: 'ok', session_id: 's' },
    ] }));
    const missions = manager(spawnFn, { limitsFile });
    missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-5' }, kind: 'qa' });
    missions.poll();
    expect(JSON.parse(readFileSync(limitsFile, 'utf8'))).toMatchObject({
      five_hour: { used_percentage: 58, resets_at: 1793722800 }, seven_day: { used_percentage: 78, resets_at: 1794045600 },
    });
  });

  it('liga a missão ao run aberto pelo agente (runs.agent.mission)', () => {
    const { spawnFn } = fakeSpawn(() => ({ lines: [] }));
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-4' }, kind: 'qa' });
    const store = new StateStore(db, config);
    store.agent = { client: 'claude-code', mission: m.id };
    const run = store.startRun({ issueKey: 'FIX-4', env: 'fixture-local', mode: 'manual' });
    expect(missions.list()[0]).toMatchObject({ runId: run.id, runStatus: 'PLANNING' });
  });
});

describe('pedido de permissão pelo painel', () => {
  it('espera a decisão do usuário; o painel vê o pedido redigido, o Claude Code recebe o input original', async () => {
    db.prepare(`INSERT INTO missions (id, agent, target, kind, status, created_at, updated_at) VALUES ('M-1', 'claude', 'FIX-1', 'qa', 'RUNNING', 'x', 'x')`).run();
    const input = { command: `curl -u admin:${SECRET} https://dev.exemplo.com` };
    const result = decidePermission({ db, redactor, missionId: 'M-1', pollMs: 1, sleep: async () => {
      const p = pendingPrompts(db)[0];
      if (p) answerPrompt(db, p.id, 'allow', undefined);
    } }, 'Bash', input);
    expect(await result).toEqual({ behavior: 'allow', updatedInput: input });
    const row = db.prepare('SELECT summary, input_json, status FROM prompts').get() as { summary: string; input_json: string; status: string };
    expect(row.summary).not.toContain(SECRET);
    expect(row.input_json).not.toContain(SECRET);
    expect(row.status).toBe('USED');
  });

  it('nega quando não é missão do painel, quando o usuário nega e quando ninguém responde', async () => {
    expect(await decidePermission({ db, redactor, missionId: undefined }, 'Bash', {})).toMatchObject({ behavior: 'deny' });
    db.prepare(`INSERT INTO missions (id, agent, target, kind, status, created_at, updated_at) VALUES ('M-1', 'claude', 'FIX-1', 'qa', 'RUNNING', 'x', 'x')`).run();
    const denied = decidePermission({ db, redactor, missionId: 'M-1', pollMs: 1, sleep: async () => {
      const p = pendingPrompts(db)[0];
      if (p) answerPrompt(db, p.id, 'deny', 'não remova nada');
    } }, 'mcp__novo-qa__act_approved', { action: 'click', target: { name: 'Remover' }, justification: 'teste' });
    expect(await denied).toEqual({ behavior: 'deny', message: 'o usuário negou pelo painel: não remova nada' });
    expect(await decidePermission({ db, redactor, missionId: 'M-1', pollMs: 1, timeoutMs: 5 }, 'Bash', {})).toMatchObject({ behavior: 'deny' });
    expect(db.prepare(`SELECT status FROM prompts ORDER BY id DESC LIMIT 1`).get()).toEqual({ status: 'EXPIRED' });
  });

  it('descreve a ação de risco em uma linha', () => {
    expect(describeTool('mcp__novo-qa__act_approved', { action: 'click', target: { role: 'button', name: 'Remover' }, justification: 'CT-007' }))
      .toBe('Ação de risco: click em "Remover" — CT-007');
    expect(ALLOWED_TOOLS).not.toContain('mcp__novo-qa__act_approved');
  });
});

describe('ações do painel pelo servidor', () => {
  let server: Server;
  let port: number;
  const TOKEN = 'a'.repeat(48);

  beforeEach(async () => {
    const { spawnFn } = fakeSpawn(() => ({ lines: [{ type: 'system', session_id: 's' }, { type: 'result', result: 'ok', session_id: 's' }] }));
    const missions = manager(spawnFn);
    server = createLiveServer({ db, rootDir: mkdtempSync(join(tmpdir(), 'novo-qa-m-')), redactor, missions, token: TOKEN });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'x-novo-qa-token': TOKEN, ...headers } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: out }));
    });
    req.on('error', reject);
    req.end(data);
  });

  it('exige a chave da página e corpo JSON', async () => {
    expect((await post('/api/missions', { target: 'FIX-1' }, { 'x-novo-qa-token': 'errada' })).status).toBe(403);
    expect((await post('/api/missions', { target: 'FIX-1' }, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('lança, responde pedido e recusa alvo inválido', async () => {
    const launched = await post('/api/missions', { target: 'FIX-1', kind: 'explore', objective: 'ver tudo' });
    expect(launched.status).toBe(200);
    expect(JSON.parse(launched.body)).toMatchObject({ target: 'FIX-1', kind: 'explore', status: 'RUNNING' });
    expect((await post('/api/missions', { target: 'javascript:alert(1)' })).status).toBe(400);

    const missionId = JSON.parse(launched.body).id as string;
    const pending = decidePermission({ db, redactor, missionId, pollMs: 5, timeoutMs: 2000 }, 'Bash', { command: 'npm test' });
    await settle();
    const id = pendingPrompts(db)[0]!.id;
    expect((await post(`/api/prompts/${id}`, { decision: 'allow' })).status).toBe(200);
    expect((await post(`/api/prompts/${id}`, { decision: 'allow' })).status).toBe(409);
    expect(await pending).toMatchObject({ behavior: 'allow' });
  });
});

describe('painel fora do alcance do navegador do teste', () => {
  it('reconhece o painel na porta padrão e na porta gravada, em qualquer nome local', async () => {
    const { isLivePanel, recordLivePort } = await import('../src/live/panel-url.ts');
    const { mkdirSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'novo-qa-pu-'));
    mkdirSync(join(root, 'data'));
    expect(isLivePanel(new URL('http://127.0.0.1:4777/'), root)).toBe(true);
    expect(isLivePanel(new URL('http://localhost:4777/api/prompts/1'), root)).toBe(true);
    expect(isLivePanel(new URL('http://127.0.0.1:4778/'), root)).toBe(false);
    recordLivePort(root, 4778);
    expect(isLivePanel(new URL('http://[::1]:4778/'), root)).toBe(true);
    expect(isLivePanel(new URL('https://dev.exemplo.com:4777/'), root)).toBe(false);
  });
});

describe('missões do Antigravity', () => {
  const agyInit = { event: 'init', conversation_id: 'conv-1', init: { permission_mode: 'request-review' } };
  const denied = (rule: string, params: unknown) => ({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_name: 'call_mcp_tool',
    tool_info: { parameters: params, error: { type: 'TOOL_ERROR', message: `permission check failed: user denied permission for ${rule}\nDo not attempt to circumvent` } } } });
  const result = (response = '') => ({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response } });
  const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]!) as { permissions: { allow: string[]; deny: string[] } };

  it('lança com o roteiro amarrado e as regras: novo-qa liberado, terminal e navegador próprio proibidos', () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ lines: [agyInit, result('Plano pronto. Aprova?')] }));
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'FIX-1' }, kind: 'explore' });
    missions.poll();
    const args = calls[0]!.args;
    expect(args[args.indexOf('-p') + 1]).toMatch(/Siga o roteiro \.claude\/skills\/qa\/SKILL\.md[\s\S]*Missão: \/qa FIX-1 --explore/);
    const { allow, deny } = settingsOf(args).permissions;
    expect(allow).toContain('mcp(novo-qa/run_status)');
    expect(allow).not.toContain('mcp(novo-qa/act_approved)');
    expect(deny).toEqual(expect.arrayContaining(['run_command', 'open_browser_url', 'browser_subagent']));
    expect(missions.get(m.id)).toMatchObject({ status: 'WAITING', session_id: 'conv-1', last_message: 'Plano pronto. Aprova?' });
  });

  it('ação de risco negada vira pedido no painel; permitida, continua com a regra e vale uma vez', async () => {
    const { consumeGrant } = await import('../src/live/prompts.ts');
    const { spawnFn, calls } = fakeSpawn((n) => ({ lines: n === 1
      ? [agyInit, denied('mcp(novo-qa/act_approved)', { ServerName: 'novo-qa', ToolName: 'act_approved', Arguments: { action: 'click', target: { name: 'Remover' }, justification: 'CT-007' } }), result()]
      : [agyInit, result('Removido.')] }));
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'FIX-2' }, kind: 'qa' });
    missions.poll();
    expect(missions.get(m.id).status).toBe('WAITING');
    const [p] = pendingPrompts(db);
    expect(p).toMatchObject({ tool: 'mcp(novo-qa/act_approved)', summary: 'Ação de risco: click em "Remover" — CT-007' });

    answerPrompt(db, p!.id, 'allow', undefined);
    missions.poll();
    const args = calls[1]!.args;
    expect(args[args.indexOf('--conversation') + 1]).toBe('conv-1');
    expect(settingsOf(args).permissions.allow).toContain('mcp(novo-qa/act_approved)');
    expect(args[args.indexOf('-p') + 1]).toMatch(/O usuário permitiu pelo painel: mcp\(novo-qa\/act_approved\)/);
    expect(consumeGrant(db, m.id, 'act_approved')).toBe(true);
    expect(consumeGrant(db, m.id, 'act_approved')).toBe(false);
    missions.poll();
    expect(missions.get(m.id).last_message).toBe('Removido.');
  });

  it('ação proibida pelo NOVO QA não vira pedido: segue com o aviso e, se insistir, chama o usuário', () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ lines: [agyInit, denied('run_command(node teste.js)', { CommandLine: 'node teste.js' }), result()] }));
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'FIX-3' }, kind: 'qa' });
    for (let i = 0; i < 4; i++) missions.poll();
    expect(pendingPrompts(db)).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.args[calls[1]!.args.indexOf('-p') + 1]).toMatch(/O NOVO QA proíbe: run_command/);
    expect(missions.get(m.id)).toMatchObject({ status: 'WAITING' });
    expect(missions.get(m.id).last_message).toMatch(/insistiu em ações proibidas/);
  });

  it('liga ao run do Antigravity pelo alvo e cliente; o novo-qa exige a concessão do painel no plan_approve', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createServer } = await import('../src/mcp/server.ts');
    const { spawnFn } = fakeSpawn(() => ({ lines: [agyInit, result('Plano pronto. Aprova?')] }));
    const missions = manager(spawnFn);
    const m = missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'FIX-8' }, kind: 'qa' });
    missions.poll();

    const store = new StateStore(db, config);
    const server = createServer({ store, redactor, rootDir: join(import.meta.dirname, '..'), config, db });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'antigravity-client', version: '1' });
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { error: r.isError === true, text: r.content[0]!.text };
    };
    const start = JSON.parse((await call('run_start', { issueKey: 'FIX-8', env: 'fixture-local', mode: 'manual' })).text) as { runId: string };
    await call('plan_save', { runId: start.runId, scenarios: [{ code: 'CT-001', title: 'Login válido', priority: 'P2', risk: 'LOW', types: ['functional'], steps: ['logar'], expected: 'dashboard' }] });
    missions.poll();
    expect(missions.get(m.id).run_id).toBe(start.runId);

    const refused = await call('plan_approve', { runId: start.runId });
    expect(refused.text).toMatch(/sem permissão do usuário no painel/);
    missions.reply(m.id, '', { approvePlan: true });
    const approved = await call('plan_approve', { runId: start.runId });
    expect(approved.text).not.toMatch(/erro|sem permissão/);
    expect(approved.error).toBe(false);
  });
});

describe('gerenciar missões e runs no painel', () => {
  it('retoma a missão parada na mesma conversa; exclui só o que não está trabalhando', () => {
    let alive = true;
    const { spawnFn, calls } = fakeSpawn(() => ({ lines: [{ type: 'system', session_id: 'sess-9' }] }));
    const missions = manager(spawnFn, { isAlive: () => alive });
    const m = missions.launch({ agent: 'claude', target: { kind: 'card', key: 'FIX-9' }, kind: 'qa' });
    missions.poll();
    expect(() => missions.archive(m.id)).toThrow(/pare antes/);
    expect(() => missions.resumeMission(m.id)).toThrow(/só missão pausada/);
    missions.stop(m.id);

    missions.resumeMission(m.id);
    const args = calls[1]!.args;
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-9');
    expect(args[args.indexOf('-p') + 1]).toBe('Continue de onde parou, seguindo o roteiro.');
    alive = false;
    missions.poll();

    missions.archive(m.id);
    expect(missions.list().map((x) => x.id)).not.toContain(m.id);
    expect(missions.get(m.id).archived_at).not.toBeNull();
  });

  it('ocultar um run tira ele do painel sem abortar', () => {
    const { spawnFn } = fakeSpawn(() => ({ lines: [] }));
    const missions = manager(spawnFn);
    const store = new StateStore(db, config, { now: () => new Date() });
    const run = store.startRun({ issueKey: 'FIX-10', env: 'fixture-local', mode: 'manual' });
    expect(buildLiveState(db, { rootDir: '/x' }).runs.map((r) => r.id)).toContain(run.id);
    missions.hideRun(run.id);
    expect(buildLiveState(db, { rootDir: '/x' }).runs.map((r) => r.id)).not.toContain(run.id);
    expect(store.getRun(run.id).status).toBe('PLANNING');
    expect(() => missions.hideRun('FIX-1-20260101T000000')).toThrow(/não existe/);
  });
});

describe('escrita no Jira pelo novo-qa', () => {
  // Nunca chama a twg real nos testes: sem binário, a ferramenta para antes de falar com o Jira.
  const saved = { twg: process.env.TWG_BIN, local: process.env.LOCALAPPDATA };
  beforeEach(() => { process.env.TWG_BIN = join(tmpdir(), 'nao-existe-twg.exe'); process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'novo-qa-la-')); });
  afterEach(() => { process.env.TWG_BIN = saved.twg; process.env.LOCALAPPDATA = saved.local; });

  async function client(name: string) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createServer } = await import('../src/mcp/server.ts');
    const server = createServer({ store: new StateStore(db, config), redactor, rootDir: join(import.meta.dirname, '..'), config, db });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const c = new Client({ name, version: '1' });
    await c.connect(a);
    return async (tool: string, args: Record<string, unknown>) => ((await c.callTool({ name: tool, arguments: args })) as { content: { text: string }[] }).content[0]!.text;
  }
  const subBug = { project: 'GURUJA', type: 'Sub-bug', parent: 'GURUJA-9038', summary: '[Arquivo] Contador soma pendentes', description: 'Como ver: abrir o Arquivo. Esperado: pendentes não somam.' };

  it('recusa texto que cita a ferramenta de automação', async () => {
    const call = await client('claude-code');
    expect(await call('jira_create_issue', { ...subBug, description: 'Reproduzido com Playwright no CT-001' })).toMatch(/não pode citar Playwright/);
  });

  it('Antigravity em missão do painel só cria com a concessão única dada no painel', async () => {
    const { spawnFn } = fakeSpawn(() => ({ lines: [] }));
    const missions = manager(spawnFn, { isAlive: () => true });
    const m = missions.launch({ agent: 'antigravity', target: { kind: 'card', key: 'GURUJA-9038' }, kind: 'qa' });
    const call = await client('antigravity-client');
    expect(await call('jira_create_issue', subBug)).toMatch(/sem permissão do usuário no painel/);
    db.prepare(`INSERT INTO prompts (mission_id, kind, tool, summary, status, decision, created_at, answered_at) VALUES (?, 'plan', 'jira_create_issue', 'x', 'ANSWERED', 'allow', 'x', 'x')`).run(m.id);
    expect(await call('jira_create_issue', subBug)).toMatch(/twg do Atlassian não encontrada/);
    expect(await call('jira_create_issue', subBug)).toMatch(/sem permissão do usuário no painel/);
  });

  it('o pedido no painel diz o que vai ser criado', () => {
    expect(describeTool('mcp__novo-qa__jira_create_issue', subBug)).toBe('Criar Sub-bug no Jira em GURUJA-9038: "[Arquivo] Contador soma pendentes"');
    expect(ALLOWED_TOOLS.some((t) => /jira_|atlassian__create|atlassian__edit|atlassian__add/.test(t))).toBe(false);
  });
});
