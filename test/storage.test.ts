import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { openDb, type Db } from '../src/state/db.ts';
import { StateStore, type ScenarioInput } from '../src/state/store.ts';
import { applyPrune, planPrune } from '../src/storage/prune.ts';

const config = loadConfig(join(import.meta.dirname, '..'));
const retention = { videoDays: 14, traceDays: 14, bugDays: 60, maxStorageGB: 10 };
const DAY = 86_400_000;
const now = new Date('2026-11-02T12:00:00Z');

let root: string;
let db: Db;
let store: StateStore;
let clock: Date;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'novo-qa-storage-'));
  db = openDb(':memory:');
  clock = new Date(now.getTime() - 30 * DAY);
  store = new StateStore(db, config, { now: () => clock });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sc = (code: string): ScenarioInput => ({ code, title: code, priority: 'P1', risk: 'HIGH', types: ['functional'], steps: ['x'], expected: 'y' });

function file(rel: string, bytes: number, ageDays: number) {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
  const t = new Date(now.getTime() - ageDays * DAY);
  utimesSync(path, t, t);
  return path;
}

/** Run concluído há 30 dias; com bug em CT-002 se withBug. */
function completedRun(issue: string, withBug: boolean): string {
  const run = store.startRun({ issueKey: issue, env: 'fixture-local', mode: 'manual' });
  store.savePlan(run.id, [sc('CT-001'), sc('CT-002')]);
  store.approvePlan(run.id);
  store.startScenario(run.id, 'CT-001');
  store.recordVerification(run.id, 'CT-001', { kind: 'ui', description: 'ok', passed: true });
  store.completeScenario(run.id, 'CT-001', { status: 'PASSED' });
  if (withBug) {
    store.startScenario(run.id, 'CT-002');
    store.recordVerification(run.id, 'CT-002', { kind: 'ui', description: 'falhou', passed: false });
    store.recordEvidence(run.id, 'CT-002', { kind: 'screenshot', path: 'x.png' });
    store.logEvent(run.id, store.getScenario(run.id, 'CT-002').id, 'inspect.network', null);
    store.completeScenario(run.id, 'CT-002', { status: 'FAILED', classification: 'PRODUCT_BUG', observed: 'quebrou' });
    store.completeRun(run.id, 'REPROVADO', 'bug');
  } else {
    store.completeScenario(run.id, 'CT-002', { status: 'NOT_EXECUTED', reason: 'fora do escopo' });
    store.completeRun(run.id, 'APROVADO', 'ok');
  }
  return run.id;
}

describe('retenção de evidências (dry-run por padrão)', () => {
  it('vídeo e trace antigos sem bug saem; com bug ficam até bugDays; PNG, _pastas e run ativo nunca', () => {
    const ok = completedRun('FIX-1', false);
    const bug = completedRun('FIX-2', true);
    const active = store.startRun({ issueKey: 'FIX-3', env: 'fixture-local', mode: 'manual' }).id;
    const v1 = file(`runs/FIX-1/${ok}/evidence/video-a.webm`, 1000, 30);
    const t1 = file(`runs/FIX-1/${ok}/evidence/CT-001-trace.zip`, 500, 30);
    const p1 = file(`runs/FIX-1/${ok}/evidence/CT-001-x.png`, 50, 30);
    const v2 = file(`runs/FIX-2/${bug}/evidence/video-b.webm`, 2000, 30);
    const t2 = file(`runs/FIX-2/${bug}/evidence/CT-002-trace.zip`, 700, 30);
    const t2ok = file(`runs/FIX-2/${bug}/evidence/CT-001-trace.zip`, 300, 30);
    const va = file(`runs/FIX-3/${active}/evidence/video-c.webm`, 900, 30);
    const cur = file('runs/_evidencias/GURUJA-1/clip.webm', 800, 90);
    const fresh = file(`runs/FIX-1/${ok}/evidence/video-new.webm`, 100, 2);

    const plan = planPrune(root, db, retention, now);
    const removed = plan.remove.map((r) => r.path).sort();
    expect(removed).toEqual([t1, t2ok, v1].map((p) => p).sort());
    expect(plan.reclaimBytes).toBe(1000 + 500 + 300);
    for (const kept of [p1, v2, t2, va, cur, fresh]) expect(removed).not.toContain(kept);
    // Nada foi apagado no dry-run.
    expect(existsSync(v1)).toBe(true);

    applyPrune(plan);
    expect(existsSync(v1)).toBe(false);
    expect(existsSync(v2)).toBe(true);
  });

  it('bug mais antigo que bugDays também sai', () => {
    const bug = completedRun('FIX-4', true);
    const v = file(`runs/FIX-4/${bug}/evidence/video.webm`, 10, 90);
    expect(planPrune(root, db, { ...retention, bugDays: 60 }, now).remove.map((r) => r.path)).toContain(v);
  });

  it('relatório de uso por tipo e o alerta de limite', () => {
    file('runs/X-1/r/evidence/a.webm', 3000, 1);
    file('runs/X-1/r/evidence/b.png', 100, 1);
    const plan = planPrune(root, db, { ...retention, maxStorageGB: 0.000001 }, now);
    expect(plan.usage.byType).toMatchObject({ webm: 3000, png: 100 });
    expect(plan.usage.overLimit).toBe(true);
  });
});
