import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Db } from '../state/db.ts';

/**
 * Pasta de evidência de um bug criado no Jira, no padrão que o usuário pede ao abrir cada card:
 * runs/_evidencias/<card>-sub-bugs/<BUG> <título curto>/ com arquivos numerados — prints dos
 * cenários, quadros do vídeo no momento do defeito (com nome que diz o que mostra), o trecho do
 * vídeo de cada cenário (com o cursor), respostas de API e um LEIA-ME. Trace nunca entra (regra:
 * nada de Playwright/trace em card ou pasta de evidência).
 */

export interface BugFrame { code: string; offsetSec: number; name: string }
export interface BugPackInput { runId: string; issueKey: string; title: string; codes: string[]; frames?: BugFrame[] }
export interface BugPackResult { folder: string; files: string[]; warnings: string[] }

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Nome de arquivo/pasta legível no Windows: sem acento, sem caracteres proibidos, curto. */
export function slug(text: string, max = 70): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[<>:"/\\|?*'\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** ffmpeg: SANCTUM_FFMPEG, o que vem com o navegador de teste (versão mais nova) ou o do PATH. */
export function findFfmpeg(): string | null {
  if (process.env.SANCTUM_FFMPEG && existsSync(process.env.SANCTUM_FFMPEG)) return process.env.SANCTUM_FFMPEG;
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : '';
  if (base && existsSync(base)) {
    const dirs = readdirSync(base).filter((d) => /^ffmpeg-\d+$/.test(d)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
    for (const d of dirs) {
      const exe = join(base, d, process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux');
      if (existsSync(exe)) return exe;
    }
  }
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { return null; }
}

export function buildBugPack(db: Db, rootDir: string, input: BugPackInput, ffmpeg = findFfmpeg()): BugPackResult {
  const run = db.prepare('SELECT id, issue_key FROM runs WHERE id = ?').get(input.runId) as Row | undefined;
  if (!run) throw new Error(`run ${input.runId} não existe`);
  const folder = join(rootDir, 'runs', '_evidencias', `${str(run.issue_key)}-sub-bugs`, `${input.issueKey} ${slug(input.title)}`);
  // A pasta é desta ferramenta: chamar de novo recria do zero (sem arquivo velho com outra numeração).
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const seen = new Set<string>();
  const files: string[] = [];
  const warnings: string[] = [];
  let n = 0;
  const next = (name: string) => `${String(++n).padStart(2, '0')}-${name}`;

  const scenarios = db.prepare('SELECT id, code, title FROM scenarios WHERE run_id = ?').all(input.runId) as Row[];
  const byCode = new Map(scenarios.map((s) => [str(s.code), s]));
  const evidence = db.prepare('SELECT scenario_id, kind, path, meta FROM evidence WHERE run_id = ? ORDER BY id').all(input.runId) as Row[];
  const abs = (p: string) => join(rootDir, p);

  // Capítulos de vídeo: início de cada cenário em cada arquivo; o trecho vai até o próximo capítulo.
  const chapters = evidence.filter((e) => e.kind === 'video' && str(e.path).endsWith('.webm')).map((e) => {
    const atSec = (JSON.parse(str(e.meta) || '{}') as { atSec?: number }).atSec;
    return { scenarioId: Number(e.scenario_id), path: str(e.path), atSec: typeof atSec === 'number' ? atSec : 0 };
  });
  const chapterOf = (code: string) => {
    const s = byCode.get(code);
    const c = s ? chapters.find((x) => x.scenarioId === Number(s.id)) : undefined;
    if (!c) return undefined;
    const after = chapters.filter((x) => x.path === c.path && x.atSec > c.atSec).map((x) => x.atSec).sort((a, b) => a - b)[0];
    return { ...c, end: after };
  };

  for (const code of input.codes) {
    const s = byCode.get(code);
    if (!s) { warnings.push(`${code} não existe no run`); continue; }
    for (const e of evidence.filter((x) => Number(x.scenario_id) === Number(s.id))) {
      const p = str(e.path);
      if (!p || /trace|\.zip$/i.test(p) || !existsSync(abs(p))) continue;
      if (/\.png$/i.test(p)) {
        // Print idêntico a outro já copiado (ex.: o topo da tela em várias falhas) só polui a pasta.
        const hash = createHash('sha1').update(readFileSync(abs(p))).digest('hex');
        if (seen.has(hash)) continue;
        seen.add(hash);
        const name = next(`${code}-${basename(p).replace(/^[A-Z]+-\d+-\d+-/, '').replace(/^CT-\d+-/, '')}`);
        copyFileSync(abs(p), join(folder, name)); files.push(name);
      } else if (/\.(txt|json)$/i.test(p)) {
        const name = next(`${code}-${basename(p).replace(/^CT-\d+-/, '')}`);
        copyFileSync(abs(p), join(folder, name)); files.push(name);
      }
    }
    // Respostas HTTP gravadas na pasta do run (http-<status>-<n>.txt) que não estão no banco.
    const dir = abs(join('runs', str(run.issue_key), input.runId, 'evidence'));
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((f) => f.startsWith(`${code}-http-`) && f.endsWith('.txt'))) {
        if (files.some((x) => x.endsWith(f.replace(`${code}-`, '')))) continue;
        const name = next(`${code}-${f.replace(`${code}-`, '')}`);
        copyFileSync(join(dir, f), join(folder, name)); files.push(name);
      }
    }
  }

  const ch = (code: string) => chapterOf(code);
  if (!ffmpeg && (input.frames?.length || input.codes.some((c) => ch(c)))) warnings.push('ffmpeg não encontrado: sem quadros nem trechos de vídeo');
  if (ffmpeg) {
    for (const f of input.frames ?? []) {
      const c = ch(f.code);
      if (!c) { warnings.push(`${f.code} sem vídeo: quadro "${f.name}" não extraído`); continue; }
      const name = next(`${slug(f.name, 80).replace(/ /g, '-')}.png`);
      try {
        execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-ss', String(c.atSec + f.offsetSec), '-i', abs(c.path), '-frames:v', '1', join(folder, name)], { stdio: 'ignore', timeout: 60_000 });
        files.push(name);
      } catch { warnings.push(`quadro "${f.name}" não extraído`); }
    }
    for (const code of input.codes) {
      const c = ch(code);
      if (!c) continue;
      const name = next(`video-${code}-com-cursor.webm`);
      const start = Math.max(0, c.atSec - 2);
      const args = ['-loglevel', 'error', '-y', '-ss', String(start), '-i', abs(c.path), ...(c.end !== undefined ? ['-t', String(c.end - start + 1)] : []), '-c', 'copy', join(folder, name)];
      try { execFileSync(ffmpeg, args, { stdio: 'ignore', timeout: 120_000 }); files.push(name); } catch { warnings.push(`trecho de vídeo do ${code} não cortado`); }
    }
  }

  // LEIA-ME: o que o bug é e como ver, a partir das explicações do relatório.
  const explained = new Map<string, Row>();
  for (const r of db.prepare(`SELECT type, payload FROM events WHERE run_id = ? AND type IN ('report.explain','report.explain_remove') ORDER BY id`).all(input.runId) as Row[]) {
    if (r.type === 'report.explain_remove') for (const c of JSON.parse(str(r.payload)) as string[]) explained.delete(c);
    else for (const x of JSON.parse(str(r.payload)) as Row[]) explained.set(str(x.code), x);
  }
  const lines = [`# ${input.issueKey} — ${input.title}`, '', `Card de origem: ${str(run.issue_key)} · run ${input.runId}`, ''];
  for (const code of input.codes) {
    const s = byCode.get(code);
    const x = explained.get(code);
    lines.push(`## ${code} — ${str(s?.title)}`, '');
    if (x) lines.push(`- Como ver: ${str(x.howToSee).replace(/\\n/g, ' ')}`, `- O que acontece: ${str(x.happens)}`, `- Esperado: ${str(x.expected)}`, '');
  }
  lines.push('## Arquivos', '', ...files.map((f) => `- ${f}`), '');
  writeFileSync(join(folder, 'LEIA-ME.md'), lines.join('\n'));
  files.push('LEIA-ME.md');
  return { folder, files, warnings };
}
