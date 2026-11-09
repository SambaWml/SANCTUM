import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { registerEnvironment } from '../src/config/register.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sanctum-env-'));
  cpSync(join(import.meta.dirname, '..', 'config'), join(root, 'config'), { recursive: true });
  // Clone limpo: sem os arquivos locais da instalação.
  for (const f of ['environments.local.yaml', 'projects.local.yaml']) rmSync(join(root, 'config', f), { force: true });
});

describe('env_register', () => {
  it('cria projeto e ambiente no arquivo local (fora do git), com criação de dados desligada', () => {
    const before = readFileSync(join(root, 'config', 'environments.yaml'), 'utf8');
    const r = registerEnvironment(root, {
      id: 'loja-hml', project: 'loja', projectName: 'Loja Online', type: 'staging', baseUrl: 'https://hml.loja.exemplo.com',
      roles: { admin: { username: 'qa.admin', envVar: 'LOJA_HML_ADMIN_PASSWORD' } }, note: 'missão sem card pedida pelo usuário',
    }, {});
    expect(r).toMatchObject({ created: true, projectCreated: true, rolesAdded: ['admin'], fillInDotEnv: ['LOJA_HML_ADMIN_PASSWORD'] });
    const config = loadConfig(root);
    expect(config.environments['loja-hml']).toMatchObject({ project: 'loja', allowDataCreation: false, roles: { admin: { password: { env: 'LOJA_HML_ADMIN_PASSWORD' } } } });
    expect(config.projects.loja).toMatchObject({ name: 'Loja Online', jiraKeys: [] });
    const after = readFileSync(join(root, 'config', 'environments.yaml'), 'utf8');
    for (const line of before.split('\n').filter((l) => l.trim().startsWith('#'))) expect(after).toContain(line.trim());
  });

  it('em ambiente existente só acrescenta papel novo; não altera papel nem libera criação de dados', () => {
    registerEnvironment(root, { id: 'loja-hml', project: 'loja', projectName: 'Loja', type: 'staging', baseUrl: 'https://hml.loja.exemplo.com',
      roles: { admin: { username: 'qa.admin', envVar: 'LOJA_HML_ADMIN_PASSWORD' } }, note: 'ambiente de partida' }, {});
    expect(() => registerEnvironment(root, { id: 'fixture-local', project: 'fixture', type: 'local', baseUrl: 'http://localhost:1', note: 'mexer no da ferramenta' }, {})).toThrow(/própria ferramenta/);
    const envId = 'loja-hml';
    const env = loadConfig(root).environments[envId]!;
    const oldRole = Object.keys(env.roles)[0]!;
    const r = registerEnvironment(root, {
      id: envId, project: env.project, type: env.type, baseUrl: 'https://outro.exemplo.com',
      roles: { [oldRole]: { username: 'trocado', envVar: 'X_PASSWORD' }, 'novo-papel': { username: 'novo', envVar: 'NOVO_PASSWORD' } },
      note: 'teste de acréscimo',
    }, {});
    expect(r).toMatchObject({ created: false, rolesAdded: ['novo-papel'], rolesKept: [oldRole] });
    const after = loadConfig(root).environments[envId]!;
    expect(after.roles[oldRole]).toEqual(env.roles[oldRole]);
    expect(after.baseUrl).toEqual(env.baseUrl);
    expect(after.allowDataCreation).toBe(env.allowDataCreation);
  });

  it('recusa projeto inexistente sem nome, URL que não é http(s) e senha literal', () => {
    expect(() => registerEnvironment(root, { id: 'x-dev', project: 'nao-existe', type: 'dev', baseUrl: 'https://x.com', note: 'teste aqui' }, {})).toThrow(/projectName/);
    expect(() => registerEnvironment(root, { id: 'x-dev', project: 'nao-existe', projectName: 'X', type: 'dev', baseUrl: 'file:///c:/', note: 'teste aqui' }, {})).toThrow();
    expect(() => registerEnvironment(root, { id: 'x-dev', project: 'nao-existe', projectName: 'X', type: 'dev', baseUrl: 'https://x.com',
      roles: { admin: { username: 'a', envVar: 'senha123' } }, note: 'teste aqui' }, {})).toThrow(/MAIÚSCULAS/);
  });
});
