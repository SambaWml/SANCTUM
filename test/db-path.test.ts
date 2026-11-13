import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDbPath, openDb } from '../src/state/db.ts';

let root: string;
const make = (name: string, withData: boolean) => {
  const db = openDb(join(root, 'data', name));
  if (withData) db.prepare(`INSERT INTO events (run_id, scenario_id, type, payload, ts) VALUES (NULL, NULL, 'x', NULL, '2026-11-09')`).run();
  db.close();
};
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('banco depois da troca de nome', () => {
  it('renomeia o novo-qa.db; sanctum.db vazio criado no meio da troca não esconde os dados', () => {
    root = mkdtempSync(join(tmpdir(), 'sanctum-db-'));
    mkdirSync(join(root, 'data'));
    make('novo-qa.db', true);
    make('sanctum.db', false);
    const path = defaultDbPath(root);
    expect(path).toBe(join(root, 'data', 'sanctum.db'));
    expect(existsSync(join(root, 'data', 'novo-qa.db'))).toBe(false);
    const db = openDb(path);
    expect((db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('sanctum.db com dados é o banco; instalação nova cria sanctum.db', () => {
    root = mkdtempSync(join(tmpdir(), 'sanctum-db-'));
    mkdirSync(join(root, 'data'));
    expect(defaultDbPath(root)).toBe(join(root, 'data', 'sanctum.db'));
    make('sanctum.db', true);
    make('novo-qa.db', true);
    expect(defaultDbPath(root)).toBe(join(root, 'data', 'sanctum.db'));
  });
});
