import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redactor } from '../security/redact.ts';
import { getTwgBin, runTwgJson } from '../sources/jira.ts';
import type { Db } from '../state/db.ts';
import { MissionError, type MissionKind, type MissionManager, type MissionTarget } from './missions.ts';
import { answerPrompt, pendingPrompts } from './prompts.ts';
import { buildLiveState, buildRun } from './state.ts';
import { buildBusiness } from './business.ts';
import { runDetail } from './detail.ts';
import type { UsageMeter } from './usage.ts';

/**
 * Servidor do painel ao vivo, só em 127.0.0.1. GET serve a página, o estado (JSON, redigido como
 * toda saída do core), prints/vídeos de `runs/` e relatórios HTML de `reports/`. O Host é conferido
 * para uma página de fora não ler o painel por DNS rebinding.
 * POST (lançar missão, responder, parar, permitir/negar) exige a chave gerada a cada início do
 * painel, que só a própria página recebe, e corpo JSON (outra origem não envia sem preflight).
 */

export interface LiveServerDeps {
  db: Db; rootDir: string; redactor: Redactor; usage?: UsageMeter; missions?: MissionManager;
  /** Chave das ações do painel; sem ela o painel é só leitura. */
  token?: string;
  now?: () => Date;
}

const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'panel.html');
const MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm' };
/**
 * O painel carrega o código uma vez. Se src/live ou src/mcp mudaram depois (auditoria 12/11: uma missão
 * pediu permissão 6 vezes para ferramentas já liberadas, porque o painel aberto tinha a lista antiga),
 * devolve a data da mudança para a tela avisar que é preciso reiniciar.
 */
const STARTED_AT = Date.now();
function staleSince(): string | null {
  let newest = 0;
  for (const dir of ['live', 'mcp', 'state']) {
    try {
      const base = join(import.meta.dirname, '..', dir);
      for (const f of readdirSync(base)) if (f.endsWith('.ts')) newest = Math.max(newest, statSync(join(base, f)).mtimeMs);
    } catch { /* pasta ausente: nada a comparar */ }
  }
  return newest > STARTED_AT ? new Date(newest).toISOString() : null;
}

const KINDS: MissionKind[] = ['qa', 'explore', 'retest', 'resume', 'analyze', 'automate'];

/** Arquivo (relativo à raiz do projeto) dentro de `base`, seguindo links; null se sair da pasta ou não existir. */
export function insideDir(rootDir: string, base: string, file: string): string | null {
  const abs = resolve(rootDir, file);
  if (!existsSync(abs) || !existsSync(base)) return null;
  const real = realpathSync(abs);
  const rel = relative(realpathSync(base), real);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) && statSync(real).isFile() ? real : null;
}

/** Alvo da missão: chave de card ou URL http(s) de qualquer sistema. */
/**
 * Card (PROJ-123, ou o link do card no Jira) ou endereço do sistema. Endereço sem http(s) é aceito:
 * localhost e IP viram http://, o resto https://. Chave de card nunca tem ponto, então não há ambiguidade.
 */
export function parseTarget(v: unknown): MissionTarget | null {
  if (typeof v !== 'string') return null;
  let text = v.trim();
  const key = /(?:browse\/|selectedIssue=|^)([A-Za-z][A-Za-z0-9]+-\d+)(?:$|[?#&/])/.exec(text);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  // Chave sozinha, ou link do Jira (browse/selectedIssue). Endereço de outro sistema que termina em "ABC-12" continua endereço.
  if (key && (!hasScheme || /atlassian\.net|\/browse\/|selectedIssue=/.test(text))) return { kind: 'card', key: key[1]!.toUpperCase() };
  if (!hasScheme && /^[^\s/]+(\.[^\s/]+|:\d+)/.test(text)) {
    text = `${/^(localhost|127\.|10\.|192\.168\.|\[?::1)/i.test(text) ? 'http' : 'https'}://${text}`;
  }
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:' ? { kind: 'url', url: u.href } : null;
  } catch {
    return null;
  }
}

export function createLiveServer(deps: LiveServerDeps): Server {
  const { db, rootDir, redactor } = deps;
  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      // O painel aprova pedidos do agente: nunca dentro de iframe de outra página (clickjacking, auditoria 13/11).
      'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(redactor.value(body)));

  async function handlePost(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    try {
      const missions = deps.missions;
      if (!missions || !deps.token) return json(res, 405, { error: 'painel só de leitura' });
      const given = String(req.headers['x-sanctum-token'] ?? '');
      if (given.length !== deps.token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(deps.token))) {
        return json(res, 403, { error: 'chave do painel inválida — recarregue a página' });
      }
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'corpo JSON obrigatório' });
      const body = await readJson(req);

      if (path === '/api/missions') {
        const target = parseTarget(body.target);
        if (!target) return json(res, 400, { error: 'informe a chave do card ou a URL do sistema' });
        const kind = KINDS.includes(body.kind as MissionKind) ? (body.kind as MissionKind) : 'qa';
        const objective = typeof body.objective === 'string' ? body.objective.slice(0, 2000) : undefined;
        const agent = body.agent === 'antigravity' ? 'antigravity' : 'claude';
        const images = Array.isArray(body.images)
          ? (body.images as { name?: string; dataBase64?: string }[]).filter(x => typeof x?.dataBase64 === 'string').map(x => ({ name: String(x.name || 'image.png'), dataBase64: String(x.dataBase64) }))
          : [];
        return json(res, 200, missions.launch({ agent, target, kind, objective, images }));
      }
      const m = /^\/api\/missions\/(M-[0-9T-]+)\/(reply|stop|resume|archive|done)$/.exec(path);
      if (m) {
        if (m[2] === 'done') return json(res, 200, missions.complete(m[1]!));
        if (m[2] === 'stop') return json(res, 200, missions.stop(m[1]!));
        if (m[2] === 'resume') return json(res, 200, missions.resumeMission(m[1]!));
        if (m[2] === 'archive') return json(res, 200, missions.archive(m[1]!));
        const text = typeof body.text === 'string' ? body.text.slice(0, 4000) : '';
        const images = Array.isArray(body.images)
          ? (body.images as { name?: string; dataBase64?: string }[]).filter(x => typeof x?.dataBase64 === 'string').map(x => ({ name: String(x.name || 'image.png'), dataBase64: String(x.dataBase64) }))
          : [];
        return json(res, 200, missions.reply(m[1]!, text, { approvePlan: body.approvePlan === true, images }));
      }
      const hide = /^\/api\/runs\/([A-Z][A-Z0-9]*-\d+-\d{8}T\d{6}(?:-\d+)?)\/hide$/.exec(path);
      if (hide) {
        missions.hideRun(hide[1]!);
        return json(res, 200, { ok: true });
      }
      const abort = /^\/api\/runs\/([A-Z][A-Z0-9]*-\d+-\d{8}T\d{6}(?:-\d+)?)\/abort$/.exec(path);
      if (abort) {
        return json(res, 200, missions.abortRun(abort[1]!, typeof body.reason === 'string' ? body.reason.slice(0, 300) : ''));
      }
      if (path === '/api/runs/hide-inactive') {
        const count = missions.hideAllInactive();
        return json(res, 200, { ok: true, count });
      }
      if (path === '/api/jira/comment') {
        const card = typeof body.card === 'string' ? body.card.trim() : '';
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!card || !text) return json(res, 400, { error: 'card e texto obrigatórios' });
        if (/playwright|trace\.zip|\.trace\b/i.test(text)) {
          return json(res, 400, { error: 'comentário não pode citar Playwright nem trace' });
        }
        const bin = getTwgBin();
        if (!bin) return json(res, 400, { error: 'CLI twg do Atlassian não encontrada no ambiente' });
        try {
          const raw = runTwgJson(['jira', 'workitem', 'comment', 'create', '--issue-id', card, '--body', text, '--body-format', 'markdown']);
          return json(res, 200, { ok: true, raw });
        } catch (err) {
          const e = err as { stderr?: string; stdout?: string; message: string };
          return json(res, 500, { error: (e.stderr || e.stdout || e.message).trim().slice(0, 400) });
        }
      }
      const p = /^\/api\/prompts\/(\d+)$/.exec(path);
      if (p) {
        const decision = body.decision === 'allow' ? 'allow' : body.decision === 'deny' ? 'deny' : null;
        if (!decision) return json(res, 400, { error: 'decision: allow ou deny' });
        const ok = answerPrompt(db, Number(p[1]), decision, typeof body.message === 'string' ? body.message.slice(0, 500) : undefined);
        return ok ? json(res, 200, { ok: true }) : json(res, 409, { error: 'pedido já respondido ou expirado' });
      }
      return json(res, 404, { error: 'não encontrado' });
    } catch (err) {
      const known = err instanceof MissionError || err instanceof SyntaxError;
      return json(res, known ? 400 : 500, { error: redactor.text((err as Error).message) });
    }
  }

  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, 'text/plain; charset=utf-8', 'host não permitido');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST') return void handlePost(req, res, url.pathname);
      if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'método não permitido');

      if (url.pathname === '/') {
        const page = readFileSync(PAGE, 'utf8').replace('__SANCTUM_TOKEN__', deps.token && deps.missions ? deps.token : '')
          .replace('__SANCTUM_JIRA__', /^https:\/\/[\w.-]+$/.test(process.env.SANCTUM_JIRA_URL ?? '') ? process.env.SANCTUM_JIRA_URL! : '');
        return send(res, 200, 'text/html; charset=utf-8', page);
      }
      if (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico') {
        const favPath = join(dirname(PAGE), 'favicon.png');
        if (existsSync(favPath)) return send(res, 200, 'image/png', readFileSync(favPath));
      }
      if (url.pathname === '/api/state') {
        return json(res, 200, {
          ...buildLiveState(db, { rootDir, now: deps.now?.() }),
          business: buildBusiness(db, { rootDir, now: deps.now?.(), days: Number(url.searchParams.get('days') ?? 7) }),
          usage: deps.usage?.state() ?? null,
          missions: deps.missions?.list() ?? [],
          prompts: deps.missions ? pendingPrompts(db) : [],
          // Código do painel mudou depois que ele subiu: as regras em memória (o que cada agente pode sem pedir) estão velhas.
          staleSince: staleSince(),
        });
      }

      // Detalhe do run (painel lateral): cenários com verificações, passo a passo completo, prints e vídeo.
      const detailMatch = /^\/api\/runs\/([^/]+)\/detail$/.exec(url.pathname);
      if (detailMatch) {
        const runId = decodeURIComponent(detailMatch[1]!);
        const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
        if (!row) return json(res, 404, { error: 'run não encontrado' });
        const run = buildRun(row, (sql, ...a) => db.prepare(sql).all(...a) as Record<string, unknown>[], (sql, ...a) => db.prepare(sql).get(...a) as Record<string, unknown> | undefined, { rootDir, now: deps.now?.() });
        return json(res, 200, { run, detail: runDetail(db, runId, rootDir) });
      }
      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1]!);
        const row = db.prepare('SELECT * FROM runs WHERE id = ? OR issue_key = ? ORDER BY started_at DESC LIMIT 1').get(runId, runId) as Record<string, unknown> | undefined;
        if (!row) return json(res, 404, { error: 'run não encontrado' });
        const run = buildRun(row, (sql, ...a) => db.prepare(sql).all(...a) as Record<string, unknown>[], (sql, ...a) => db.prepare(sql).get(...a) as Record<string, unknown> | undefined, { rootDir, now: deps.now?.() });
        return json(res, 200, run);
      }

      const evidence = /^\/evidence\/(\d+)$/.exec(url.pathname);
      if (evidence) {
        const row = db.prepare('SELECT path FROM evidence WHERE id = ?').get(Number(evidence[1])) as { path?: string } | undefined;
        const file = row?.path ? insideDir(rootDir, join(rootDir, 'runs'), row.path) : null;
        const type = file ? MEDIA[extname(file).toLowerCase()] : undefined;
        if (!file || !type) return send(res, 404, 'text/plain; charset=utf-8', 'evidência não encontrada');
        return stream(req, res, file, type);
      }

      // O relatório HTML aponta a evidência por caminho relativo (../../runs/...): servida aqui,
      // só imagem/vídeo e só de dentro de runs/ (caminho real conferido).
      if (url.pathname.startsWith('/runs/')) {
        let rel: string;
        try { rel = decodeURIComponent(url.pathname.slice(1)); } catch { return send(res, 400, 'text/plain; charset=utf-8', 'caminho inválido'); }
        const file = insideDir(rootDir, join(rootDir, 'runs'), rel);
        const type = file ? MEDIA[extname(file).toLowerCase()] : undefined;
        if (!file || !type) return send(res, 404, 'text/plain; charset=utf-8', 'evidência não encontrada');
        return stream(req, res, file, type);
      }

      const report =/^\/report\/([A-Z][A-Z0-9]*-\d+)-(\d{8}T\d{6}(?:-\d+)?)$/.exec(url.pathname);
      if (report) {
        const card = report[1]!;
        const file = insideDir(rootDir, join(rootDir, 'reports'), join('reports', card, `${card}-${report[2]}.html`));
        if (!file) return send(res, 404, 'text/plain; charset=utf-8', 'relatório não gerado ainda');
        return send(res, 200, 'text/html; charset=utf-8', readFileSync(file));
      }
      return send(res, 404, 'text/plain; charset=utf-8', 'não encontrado');
    } catch (err) {
      return send(res, 500, 'text/plain; charset=utf-8', redactor.text((err as Error).message));
    }
  });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 30 * 1024 * 1024) { reject(new SyntaxError('corpo grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
        resolveBody(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/** Vídeo precisa de Range para o navegador pular para o capítulo do cenário. */
function stream(req: IncomingMessage, res: ServerResponse, file: string, type: string): void {
  const size = statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (!range || (!range[1] && !range[2])) {
    res.writeHead(200, { ...headers, 'content-length': size });
    createReadStream(file).pipe(res);
    return;
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
  createReadStream(file, { start, end }).pipe(res);
}
