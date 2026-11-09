import { readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { Db } from '../state/db.ts';

/**
 * Retenção de evidências pesadas (vídeo .webm e trace .zip) em runs/.
 * Só planeja: apagar é applyPrune, chamado explicitamente (sanctum storage --apply).
 * Nunca toca: PNG/.txt/relatórios, pastas runs/_* (montadas à mão), runs ativos.
 * Evidência de bug fica mais tempo: vídeo de run com PRODUCT_BUG e trace do cenário com bug.
 */

export interface Retention {
  videoDays: number;
  traceDays: number;
  bugDays: number;
  maxStorageGB: number;
}

export interface PrunePlan {
  remove: { path: string; bytes: number; reason: string }[];
  reclaimBytes: number;
  usage: { totalBytes: number; byType: Record<string, number>; overLimit: boolean };
}

const DAY = 86_400_000;
const ACTIVE = new Set(['PLANNING', 'AWAITING_APPROVAL', 'EXECUTING']);

function walk(dir: string, out: { path: string; bytes: number; mtime: number }[]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path, out);
    else if (e.isFile()) {
      const st = statSync(path);
      out.push({ path, bytes: st.size, mtime: st.mtimeMs });
    }
  }
}

/** Uso de disco de runs/ por extensão (doctor e sanctum storage). */
export function runsUsage(rootDir: string, maxStorageGB: number) {
  const files: { path: string; bytes: number; mtime: number }[] = [];
  walk(join(rootDir, 'runs'), files);
  const byType: Record<string, number> = {};
  let totalBytes = 0;
  for (const f of files) {
    const ext = extname(f.path).slice(1).toLowerCase() || 'outros';
    byType[ext] = (byType[ext] ?? 0) + f.bytes;
    totalBytes += f.bytes;
  }
  return { files, usage: { totalBytes, byType, overLimit: totalBytes > maxStorageGB * 1e9 } };
}

export function planPrune(rootDir: string, db: Db, retention: Retention, now: Date = new Date()): PrunePlan {
  const runsDir = join(rootDir, 'runs');
  const { files, usage } = runsUsage(rootDir, retention.maxStorageGB);

  const runStatus = db.prepare('SELECT status FROM runs WHERE id = ?');
  const bugInRun = db.prepare(`SELECT COUNT(*) AS n FROM scenarios WHERE run_id = ? AND status = 'FAILED' AND classification = 'PRODUCT_BUG'`);
  const bugScenario = db.prepare(`SELECT COUNT(*) AS n FROM scenarios WHERE run_id = ? AND code = ? AND status = 'FAILED' AND classification = 'PRODUCT_BUG'`);

  const remove: PrunePlan['remove'] = [];
  for (const f of files) {
    const ext = extname(f.path).toLowerCase();
    if (ext !== '.webm' && ext !== '.zip') continue;
    const parts = relative(runsDir, f.path).split(sep);
    // runs/<card>/<runId>/...; runs/_*/ e arquivos soltos na raiz de runs/ ficam.
    if (parts.length < 3 || parts[0]!.startsWith('_')) continue;
    const runId = parts[1]!;
    const status = (runStatus.get(runId) as { status: string } | undefined)?.status;
    if (status && ACTIVE.has(status)) continue;

    const name = parts[parts.length - 1]!;
    const traceCode = /^((?:CT|EXP)-\d+)-trace\.zip$/i.exec(name)?.[1];
    const isBug = ext === '.webm'
      ? (bugInRun.get(runId) as { n: number }).n > 0
      : traceCode !== undefined && (bugScenario.get(runId, traceCode) as { n: number }).n > 0;
    const days = isBug ? retention.bugDays : ext === '.webm' ? retention.videoDays : retention.traceDays;
    const age = (now.getTime() - f.mtime) / DAY;
    if (age <= days) continue;
    remove.push({ path: f.path, bytes: f.bytes, reason: `${ext === '.webm' ? 'vídeo' : 'trace'}${isBug ? ' de bug' : ''} com ${Math.floor(age)} dias (limite ${days})` });
  }
  return {
    remove,
    reclaimBytes: remove.reduce((acc, r) => acc + r.bytes, 0),
    usage,
  };
}

export function applyPrune(plan: PrunePlan): number {
  let removed = 0;
  for (const r of plan.remove) {
    rmSync(r.path, { force: true });
    removed++;
  }
  return removed;
}
