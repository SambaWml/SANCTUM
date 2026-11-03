import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { checkAtlassianMcp, checkEnvironments, checkNode, checkSqlite, runDoctor } from '../src/doctor/checks.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'novo-qa-doctor-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('doctor', () => {
  it('valida versão mínima do Node', () => {
    expect(checkNode('v24.11.1').status).toBe('ok');
    expect(checkNode('v22.13.0').status).toBe('ok');
    expect(checkNode('v22.12.0').status).toBe('fail');
    expect(checkNode('v20.0.0').status).toBe('fail');
  });

  it('SQLite disponível', () => {
    expect(checkSqlite().status).toBe('ok');
  });

  it('variáveis ausentes geram aviso com nome e sem valor', () => {
    const config = loadConfig(REPO_ROOT);
    const missing = checkEnvironments(config, {}).find((c) => c.name === 'Ambiente fixture-local');
    expect(missing?.status).toBe('warn');
    expect(missing?.detail).toContain('FIXTURE_ADMIN_PASSWORD');

    const present = checkEnvironments(config, { FIXTURE_ADMIN_PASSWORD: 'segredo-123' }).find((c) => c.name === 'Ambiente fixture-local');
    expect(present?.status).toBe('ok');
    expect(present?.detail).not.toContain('segredo-123');
  });

  it('detecta Atlassian MCP global, por projeto ou em .mcp.json', () => {
    const home = tempDir();
    const root = tempDir();
    expect(checkAtlassianMcp(root, home).status).toBe('warn');

    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [root]: { mcpServers: { atlassian: {} } } } }));
    expect(checkAtlassianMcp(root, home).status).toBe('ok');

    writeFileSync(join(home, '.claude.json'), '{}');
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'my-atlassian': {} } }));
    expect(checkAtlassianMcp(root, home).detail).toContain('my-atlassian');
  });

  it('roda sem falhas no repositório (avisos permitidos)', () => {
    const results = runDoctor({ rootDir: REPO_ROOT, homeDir: tempDir(), env: {}, nodeVersion: process.version });
    expect(results.filter((r) => r.status === 'fail')).toEqual([]);
  });
});

describe('doctor: configuração do Codex', () => {
  it('caminho fixo do projeto no .codex que não bate com a pasta atual vira aviso', async () => {
    const { checkCodexPaths } = await import('../src/doctor/checks.ts');
    const { mkdirSync } = await import('node:fs');
    const d = tempDir();
    expect(checkCodexPaths(d).status).toBe('ok'); // sem .codex: nada a conferir
    mkdirSync(join(d, '.codex'));
    writeFileSync(join(d, '.codex', 'config.toml'), `[mcp_servers.novo-qa]\ncwd = '${d}'\n`);
    writeFileSync(join(d, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `node "${d.replace(/\\/g, '/')}/.codex/hooks/guard-shell.mjs"` }] }] } }));
    expect(checkCodexPaths(d).status).toBe('ok');
    writeFileSync(join(d, '.codex', 'config.toml'), "[mcp_servers.novo-qa]\ncwd = 'C:\\\\outra\\\\pasta'\n");
    expect(checkCodexPaths(d)).toMatchObject({ status: 'warn', detail: expect.stringContaining('config.toml') });
  });

  it('o .codex deste repositório aponta para esta pasta', async () => {
    const { checkCodexPaths } = await import('../src/doctor/checks.ts');
    expect(checkCodexPaths(REPO_ROOT).status).toBe('ok');
  });
});

describe('doctor: higiene e disco', () => {
  it('script solto que abre navegador vira aviso', async () => {
    const { checkStrayDrivers } = await import('../src/doctor/checks.ts');
    const d = tempDir();
    writeFileSync(join(d, 'ok.cjs'), 'console.log(1)');
    expect(checkStrayDrivers(d).status).toBe('ok');
    writeFileSync(join(d, 'pay.cjs'), "const { chromium } = require('play' + 'wright'); chromium.launch();");
    expect(checkStrayDrivers(d)).toMatchObject({ status: 'warn', detail: expect.stringContaining('pay.cjs') });
  });

  it('runs/ acima do limite da política vira aviso', async () => {
    const { checkStorage } = await import('../src/doctor/checks.ts');
    const { mkdirSync } = await import('node:fs');
    const d = tempDir();
    mkdirSync(join(d, 'runs', 'X-1'), { recursive: true });
    writeFileSync(join(d, 'runs', 'X-1', 'v.webm'), Buffer.alloc(2000));
    const config = loadConfig(REPO_ROOT);
    expect(checkStorage(d, config).status).toBe('ok');
    const tiny = { ...config, policy: { ...config.policy, evidence: { ...config.policy.evidence, retention: { ...config.policy.evidence.retention, maxStorageGB: 0.000001 } } } };
    expect(checkStorage(d, tiny).status).toBe('warn');
  });
});
