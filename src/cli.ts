import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { config as loadDotEnv } from 'dotenv';
import { BrowserService } from './browser/service.ts';
import { loadConfig } from './config/load.ts';
import { runDoctor, type CheckStatus } from './doctor/checks.ts';
import { createServer } from './mcp/server.ts';
import { computeRunMetrics, formatMetrics } from './metrics/run-metrics.ts';
import { ingestTranscripts, transcriptDirs } from './metrics/transcripts.ts';
import { Redactor } from './security/redact.ts';
import { SecretStore } from './security/secrets.ts';
import { defaultDbPath, openDb } from './state/db.ts';
import { MissionManager } from './live/missions.ts';
import { recordLivePort } from './live/panel-url.ts';
import { createLiveServer } from './live/server.ts';
import { UsageMeter } from './live/usage.ts';
import { StateStore } from './state/store.ts';
import { applyPrune, planPrune } from './storage/prune.ts';
import { promoteStaging, stagingSummary } from './knowledge/staging.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

function doctor(): number {
  loadDotEnv({ path: join(ROOT, '.env'), quiet: true });
  const results = runDoctor({ rootDir: ROOT, homeDir: homedir(), env: process.env, nodeVersion: process.version });
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${ICON[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log(`\n${fails} falha(s), ${warns} aviso(s)`);
  return fails > 0 ? 1 : 0;
}

/** sanctum metrics <runId|card>  ·  sanctum metrics --schema */
async function metrics(arg?: string): Promise<number> {
  const config = loadConfig(ROOT);
  if (arg === '--schema') return schema(config);
  if (!arg) {
    console.log('Uso: sanctum metrics <runId|card> | --schema');
    return 1;
  }
  const db = openDb(defaultDbPath(ROOT));
  const store = new StateStore(db, config);
  const ingested = ingestTranscripts(db, transcriptDirs(ROOT, homedir(), process.env.SANCTUM_TRANSCRIPTS_DIR || undefined, process.env.SANCTUM_CLIENT));
  const run = store.resolveRun(arg);
  const m = computeRunMetrics(db, store, run.id);
  console.log(`${run.issue_key} · ${run.id} (${ingested.calls} chamadas lidas de ${ingested.files} transcript(s))\n`);
  for (const line of formatMetrics(m)) console.log(line);
  if (m.perScenario.costliest.length) {
    console.log('\nCenários mais caros:');
    for (const c of m.perScenario.costliest) console.log(`  ${c.code.padEnd(8)} ${String(c.fresh).padStart(8)} tokens  ${String(c.calls).padStart(3)} chamadas  ${c.minutes} min  ${c.status}`);
  }
  return 0;
}

/** Custo fixo das ferramentas: tamanho do schema de cada uma, como o modelo recebe. */
async function schema(config: ReturnType<typeof loadConfig>): Promise<number> {
  const db = openDb(':memory:');
  const store = new StateStore(db, config);
  const secrets = SecretStore.fromConfig(config, {});
  const redactor = new Redactor();
  const browser = new BrowserService({ rootDir: ROOT, config, store, secrets, redactor });
  const server = createServer({ store, redactor, rootDir: ROOT, config, db, secrets, browser });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'cli', version: '0' });
  await client.connect(a);
  const { tools } = await client.listTools();
  const sizes = tools.map((t) => ({ name: t.name, tokens: Math.ceil(JSON.stringify(t).length / 4) })).sort((x, y) => y.tokens - x.tokens);
  for (const s of sizes) console.log(`${s.name.padEnd(20)} ~${s.tokens}`);
  console.log(`\n${tools.length} ferramentas · ~${sizes.reduce((acc, s) => acc + s.tokens, 0)} tokens de schema (estimativa: caracteres/4)`);
  return 0;
}

const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;

/** sanctum storage [--apply]: uso de runs/ e o que a retenção removeria (só apaga com --apply). */
function storage(arg?: string): number {
  const config = loadConfig(ROOT);
  const retention = config.policy.evidence.retention;
  const db = openDb(defaultDbPath(ROOT));
  const plan = planPrune(ROOT, db, retention);
  console.log(`runs/: ${gb(plan.usage.totalBytes)}${plan.usage.overLimit ? ` (acima do limite de ${retention.maxStorageGB} GB)` : ''}`);
  for (const [ext, bytes] of Object.entries(plan.usage.byType).sort((a, b) => b[1] - a[1])) console.log(`  ${ext.padEnd(8)} ${gb(bytes)}`);
  const videos = plan.remove.filter((r) => r.path.endsWith('.webm')).length;
  console.log(`
Retenção (vídeo ${retention.videoDays}d, trace ${retention.traceDays}d, bug ${retention.bugDays}d): ${videos} vídeo(s) e ${plan.remove.length - videos} trace(s), ${gb(plan.reclaimBytes)} a liberar`);
  if (arg !== '--apply') {
    console.log('Simulação: nada foi apagado. Para apagar: sanctum storage --apply');
    return 0;
  }
  console.log(`Apagados: ${applyPrune(plan)} arquivo(s)`);
  return 0;
}

/**
 * sanctum knowledge <projeto>                         propostas pendentes por módulo
 * sanctum knowledge <projeto>/<módulo> "<resumo>"     promove staging revisado (reviewed: true)
 */
function knowledge(arg?: string): number {
  if (!arg) {
    console.log('Uso: sanctum knowledge <projeto> | <projeto>/<módulo> "<resumo do módulo>"');
    return 1;
  }
  const [project, module] = arg.split('/');
  if (!module) {
    const rows = stagingSummary(ROOT, project!);
    if (!rows.length) console.log(`Nenhuma proposta em knowledge/${project}/_staging`);
    for (const r of rows) console.log(`${r.reviewed ? '✓' : '·'} ${r.module.padEnd(22)} ${r.proposals} proposta(s)${r.reviewed ? ' — revisado, pronto para promover' : ''}`);
    console.log('\nRevise o arquivo, ajuste/remova propostas, marque reviewed: true e rode: sanctum knowledge <projeto>/<módulo> "<resumo>"');
    return 0;
  }
  const summary = process.argv[4];
  if (!summary) {
    console.log('Informe o resumo do módulo (uma frase): sanctum knowledge <projeto>/<módulo> "<resumo>"');
    return 1;
  }
  const r = promoteStaging(ROOT, project!, module, summary);
  console.log(`${r.file}: ${r.promoted} afirmação(ões) promovida(s), ${r.total} no módulo`);
  return 0;
}

/**
 * sanctum live [porta]: Painel do Sanctum em http://127.0.0.1:<porta>. Lê o banco e lança/acompanha
 * missões do Claude em segundo plano; as ações da página exigem a chave gerada a cada início.
 */
async function live(arg?: string): Promise<number> {
  loadDotEnv({ path: join(ROOT, '.env'), quiet: true });
  const port = Number(arg ?? process.env.SANCTUM_LIVE_PORT ?? 4777);
  const config = loadConfig(ROOT);
  const secrets = SecretStore.fromConfig(config);
  const redactor = new Redactor({ secrets: secrets.valuesForRedaction(), extraSensitiveKeys: config.policy.redaction.extraSensitiveKeys });
  const dbPath = defaultDbPath(ROOT);
  // O painel escreve só missões e respostas do usuário (tabelas missions/prompts); o resto é leitura.
  const db = openDb(dbPath);
  const missions = new MissionManager({ db, rootDir: ROOT, claudeBin: process.env.SANCTUM_CLAUDE_BIN || undefined, agyBin: process.env.SANCTUM_AGY_BIN || undefined, limitsFile: join(ROOT, 'data', 'usage-limits.json') });
  missions.recover();
  missions.start();
  console.log('Lendo o consumo dos transcripts dos últimos 7 dias…');
  const usage = new UsageMeter({
    claudeProjectsDir: join(homedir(), '.claude', 'projects'),
    claudeLimitsFile: join(ROOT, 'data', 'usage-limits.json'),
    codexSessionsDir: join(homedir(), '.codex', 'sessions'),
  });
  usage.state();
  const server = createLiveServer({ db, rootDir: ROOT, redactor, usage, missions, token: randomBytes(24).toString('hex') });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (err) {
    db.close();
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    console.log(`Porta ${port} ocupada: o painel já está aberto em http://127.0.0.1:${port} ou use outra porta (npm run live -- 4778)`);
    return 1;
  }
  recordLivePort(ROOT, port);
  console.log(`Painel do Sanctum em http://127.0.0.1:${port}  (Ctrl+C para sair)`);
  await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  server.close();
  db.close();
  return 0;
}

const commands: Record<string, (arg?: string) => number | Promise<number>> = { doctor, metrics, storage, knowledge, live };

const [command = 'help', arg] = process.argv.slice(2);
const run = commands[command];
if (!run) {
  console.log(`Uso: sanctum <comando>\n\nComandos:\n  doctor\n  metrics <runId|card> | --schema
  storage [--apply]
  knowledge <projeto> | <projeto>/<módulo> "<resumo>"
  live [porta]`);
  process.exit(command === 'help' ? 0 : 1);
}
process.exit(await run(arg));
