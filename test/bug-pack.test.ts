import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { buildBugPack, slug } from '../src/evidence/bug-pack.ts';
import { openDb } from '../src/state/db.ts';
import { StateStore } from '../src/state/store.ts';

const config = loadConfig(join(import.meta.dirname, '..'));

describe('pasta de evidência do bug', () => {
  it('um bug por pasta: prints sem repetição, resposta da API, LEIA-ME; nunca trace', () => {
    const root = mkdtempSync(join(tmpdir(), 'sanctum-bp-'));
    const db = openDb(':memory:');
    const store = new StateStore(db, config, { now: () => new Date('2026-11-04T15:00:00Z') });
    const run = store.startRun({ issueKey: 'FIX-1', env: 'fixture-local', mode: 'manual' });
    const scenario = { title: 'Contadores do Arquivo', priority: 'P1' as const, risk: 'HIGH' as const, types: ['functional'], steps: ['abrir'], expected: 'só cumpridos' };
    store.savePlan(run.id, [{ code: 'CT-002', ...scenario }]);
    const dir = join(root, 'runs', 'FIX-1', run.id, 'evidence');
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of [['CT-002-1-falha-ui.png', 'A'], ['CT-002-2-falha-ui.png', 'A'], ['CT-002-3-falha-network.png', 'B'], ['CT-002-trace.zip', 'Z'], ['CT-002-http-500-1.txt', 'POST /x → 500']]) {
      writeFileSync(join(dir, name!), body!);
      if (!name!.endsWith('.txt')) store.recordEvidence(run.id, 'CT-002', { kind: name!.endsWith('.zip') ? 'trace' : 'screenshot', path: `runs/FIX-1/${run.id}/evidence/${name}` });
    }
    store.logEvent(run.id, null, 'report.explain', [{ code: 'CT-002', title: 'Soma pendentes', howToSee: '1. Abrir o Arquivo', happens: 'Aba mostra 11', expected: 'Só os 6 cumpridos' }]);

    const r = buildBugPack(db, root, { runId: run.id, issueKey: 'FIX-9', title: 'Aba soma: pendentes?', codes: ['CT-002', 'CT-404'] }, null);
    expect(r.folder).toBe(join(root, 'runs', '_evidencias', 'FIX-1-sub-bugs', 'FIX-9 Aba soma pendentes'));
    expect(r.files).toEqual(['01-CT-002-falha-ui.png', '02-CT-002-falha-network.png', '03-CT-002-http-500-1.txt', 'LEIA-ME.md']);
    expect(readdirSync(r.folder).some((f) => /trace|zip/.test(f))).toBe(false);
    expect(readFileSync(join(r.folder, 'LEIA-ME.md'), 'utf8')).toMatch(/O que acontece: Aba mostra 11[\s\S]*Esperado: Só os 6 cumpridos/);
    expect(r.warnings).toEqual(['CT-404 não existe no run']);

    // Chamar de novo recria a pasta (sem sobra de arquivo antigo).
    writeFileSync(join(r.folder, '99-velho.png'), 'x');
    buildBugPack(db, root, { runId: run.id, issueKey: 'FIX-9', title: 'Aba soma: pendentes?', codes: ['CT-002'] }, null);
    expect(existsSync(join(r.folder, '99-velho.png'))).toBe(false);
  });

  it('nome de pasta legível no Windows', () => {
    expect(slug('Modal: "Editar registro" em metas passadas / RN34?')).toBe('Modal Editar registro em metas passadas RN34');
    expect(slug('Ação é exibição')).toBe('Acao e exibicao');
  });
});
