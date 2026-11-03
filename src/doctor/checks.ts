import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError, isEnvRef, loadConfig } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import { chromium } from 'playwright';
import { loadSqlite } from '../state/sqlite.ts';
import { runsUsage } from '../storage/prune.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorInput {
  rootDir: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
}

const MIN_NODE: [number, number] = [22, 13];

export function checkNode(version: string): CheckResult {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    name: 'Node.js',
    status: ok ? 'ok' : 'fail',
    detail: ok ? version : `${version} — necessário >= ${MIN_NODE.join('.')} (node:sqlite)`,
  };
}

export function checkSqlite(): CheckResult {
  try {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(':memory:');
    db.exec('create table t(x)');
    db.close();
    return { name: 'SQLite', status: 'ok', detail: 'node:sqlite disponível' };
  } catch (err) {
    return { name: 'SQLite', status: 'fail', detail: (err as Error).message };
  }
}

export function checkConfig(rootDir: string): { result: CheckResult; config?: Config } {
  try {
    const config = loadConfig(rootDir);
    const envs = Object.keys(config.environments).length;
    const projects = Object.keys(config.projects).length;
    return { result: { name: 'Config', status: 'ok', detail: `${projects} projeto(s), ${envs} ambiente(s)` }, config };
  } catch (err) {
    const detail = err instanceof ConfigError ? err.problems.join('; ') : (err as Error).message;
    return { result: { name: 'Config', status: 'fail', detail } };
  }
}

/**
 * O dotenv trata `#` em valor sem aspas como comentário: `SENHA=ab#cd` vira `ab`.
 * Devolve os NOMES das variáveis afetadas (nunca o valor).
 */
export function unquotedHashVars(dotenvText: string): string[] {
  return dotenvText
    .split(/\r?\n/)
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter(([, , value]) => !/^["'`]/.test(value!) && /\S#/.test(value!))
    .map(([, name]) => name!);
}

export function checkDotEnv(rootDir: string): CheckResult {
  const path = join(rootDir, '.env');
  if (!existsSync(path)) return { name: '.env', status: 'warn', detail: 'ausente — copie .env.example para .env' };
  const truncated = unquotedHashVars(readFileSync(path, 'utf8'));
  return truncated.length
    ? { name: '.env', status: 'fail', detail: `valor com # sem aspas é cortado no #: ${truncated.join(', ')} — use NOME="valor"` }
    : { name: '.env', status: 'ok', detail: 'encontrado' };
}

/** Lista só NOMES de variáveis ausentes, nunca valores. Ausência não é falha: o /qa pede quando for testar. */
export function checkEnvironments(config: Config, env: NodeJS.ProcessEnv): CheckResult[] {
  return Object.entries(config.environments).map(([id, e]) => {
    const names = new Set<string>();
    if (isEnvRef(e.baseUrl)) names.add(e.baseUrl.env);
    for (const role of Object.values(e.roles)) {
      if (isEnvRef(role.username)) names.add(role.username.env);
      names.add(role.password.env);
    }
    const missing = [...names].filter((n) => !env[n]);
    const roles = Object.keys(e.roles).join(', ') || 'nenhum';
    return missing.length === 0
      ? { name: `Ambiente ${id}`, status: 'ok', detail: `${e.type}, papéis: ${roles}` }
      : { name: `Ambiente ${id}`, status: 'warn', detail: `${e.type}, faltam no .env: ${missing.join(', ')}` };
  });
}

export function checkGit(rootDir: string): CheckResult {
  return existsSync(join(rootDir, '.git'))
    ? { name: 'Git', status: 'ok', detail: 'repositório inicializado' }
    : { name: 'Git', status: 'warn', detail: 'não é um repositório git' };
}

function mcpServerNames(path: string, projectDir?: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    const names = Object.keys(json.mcpServers ?? {});
    if (projectDir && json.projects) {
      const wanted = projectDir.replace(/\\/g, '/').toLowerCase();
      for (const [dir, p] of Object.entries(json.projects)) {
        if (dir.replace(/\\/g, '/').toLowerCase() === wanted) names.push(...Object.keys(p.mcpServers ?? {}));
      }
    }
    return names;
  } catch {
    return [];
  }
}

/** Só verifica se está configurado; autenticação só é testável de dentro do Claude Code. */
export function checkAtlassianMcp(rootDir: string, homeDir: string): CheckResult {
  const names = [...mcpServerNames(join(homeDir, '.claude.json'), rootDir), ...mcpServerNames(join(rootDir, '.mcp.json'))];
  const found = names.find((n) => n.toLowerCase().includes('atlassian'));
  return found
    ? { name: 'Atlassian MCP', status: 'ok', detail: `servidor "${found}" configurado (Jira/Confluence)` }
    : {
        name: 'Atlassian MCP',
        status: 'warn',
        detail: 'não configurado — claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp/authv2',
      };
}

export function checkPlaywright(): CheckResult {
  return existsSync(chromium.executablePath())
    ? { name: 'Playwright', status: 'ok', detail: 'Chromium instalado' }
    : { name: 'Playwright', status: 'fail', detail: 'navegador ausente — rode: npx playwright install chromium' };
}

export function runDoctor(input: DoctorInput): CheckResult[] {
  const results: CheckResult[] = [checkNode(input.nodeVersion), checkSqlite(), checkPlaywright(), checkGit(input.rootDir)];
  const { result, config } = checkConfig(input.rootDir);
  results.push(result, checkDotEnv(input.rootDir));
  if (config) results.push(...checkEnvironments(config, input.env), checkStorage(input.rootDir, config));
  results.push(checkStrayDrivers(input.rootDir), checkCodexPaths(input.rootDir));
  results.push(checkAtlassianMcp(input.rootDir, input.homeDir));
  return results;
}

/**
 * O Codex precisa de caminho absoluto (cwd do MCP e comando do hook). Projeto movido ou clonado em
 * outra máquina deixa esses caminhos velhos: o hook some em silêncio. Avisa quando não batem.
 */
export function checkCodexPaths(rootDir: string): CheckResult {
  const norm = (p: string) => resolve(p.replace(/\\\\/g, '\\')).toLowerCase().replace(/[\\/]+$/, '');
  const root = norm(rootDir);
  const problems: string[] = [];
  const config = join(rootDir, '.codex', 'config.toml');
  if (existsSync(config)) {
    const cwd = /^\s*cwd\s*=\s*['"]([^'"]+)['"]/m.exec(readFileSync(config, 'utf8'))?.[1];
    if (cwd && norm(cwd) !== root) problems.push(`.codex/config.toml cwd = ${cwd}`);
  }
  const hooks = join(rootDir, '.codex', 'hooks.json');
  if (existsSync(hooks)) {
    for (const m of readFileSync(hooks, 'utf8').matchAll(/node \\"([^"\\]+)\/\.codex\/hooks/g)) {
      if (norm(m[1]!) !== root) problems.push(`.codex/hooks.json aponta para ${m[1]}`);
    }
  }
  return problems.length
    ? { name: 'Codex', status: 'warn', detail: `${problems.join('; ')} — atualize para ${rootDir}` }
    : { name: 'Codex', status: 'ok', detail: existsSync(config) ? 'caminhos do .codex conferem' : 'sem .codex' };
}

/** Evidências acima do limite da política: sugere a retenção (npm run storage). */
export function checkStorage(rootDir: string, config: Config): CheckResult {
  const max = config.policy.evidence.retention.maxStorageGB;
  const { usage } = runsUsage(rootDir, max);
  const gb = (usage.totalBytes / 1e9).toFixed(1);
  return usage.overLimit
    ? { name: 'Evidências', status: 'warn', detail: `runs/ com ${gb} GB (limite ${max} GB): veja npm run storage` }
    : { name: 'Evidências', status: 'ok', detail: `runs/ com ${gb} GB` };
}

/** Script solto na raiz que abre navegador opera o app por fora do Action Guard. */
const DRIVER = /require\(['"](?:playwright|puppeteer)|from ['"](?:playwright|puppeteer)|\.launch\(/;

export function checkStrayDrivers(rootDir: string): CheckResult {
  const stray = readdirSync(rootDir)
    .filter((name) => /\.(?:c|m)?js$/.test(name))
    .filter((name) => DRIVER.test(readFileSync(join(rootDir, name), 'utf8')));
  return stray.length
    ? { name: 'Scripts avulsos', status: 'warn', detail: `${stray.join(', ')} abrem navegador por fora do Action Guard: remova` }
    : { name: 'Scripts avulsos', status: 'ok', detail: 'nenhum script de navegador na raiz' };
}
