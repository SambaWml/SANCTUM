import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executionHints, mergeExecutionKnowledge, playwrightLine, type ExecutionEntry } from '../src/knowledge/execution.ts';

const root = mkdtempSync(join(tmpdir(), 'novo-qa-ek-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const entry = (route: string, name: string, lastSeen: string, over: Partial<ExecutionEntry> = {}): ExecutionEntry => {
  const target = { role: 'button', name, exact: true };
  return { route, action: 'click', target, playwright: playwrightLine('click', target, null), scenario: 'CT-001', validatedIn: ['R1'], lastSeen, ...over };
};

describe('execution knowledge enxuto', () => {
  it('nome com número vira regex estável (contador muda entre runs)', () => {
    expect(playwrightLine('click', { role: 'button', name: 'Reforços 6', exact: true }, null))
      .toBe(String.raw`await page.getByRole('button', { name: /^Reforços \d+$/ }).click();`);
    expect(playwrightLine('click', { role: 'button', name: 'Salvar', exact: true }, null))
      .toBe("await page.getByRole('button', { name: 'Salvar', exact: true }).click();");
  });

  it('mesmo alvo com contador diferente funde numa entrada; nome gigante (ex.: com IP) não entra', () => {
    const r = mergeExecutionKnowledge(root, 'p', 'meta', [
      entry('/aluno/visao-geral', 'Reforços 0', '2026-10-20'),
      entry('/aluno/visao-geral', 'Reforços 6', '2026-10-27'),
      entry('/aluno/visao-geral', `Termos de uso Versão 8 ${'x'.repeat(120)} 13.82.102.15 Windows`, '2026-10-27'),
    ]);
    expect(r.total).toBe(1);
  });

  it('dicas do brief: sem repetição entre módulos e as mais recentes primeiro', () => {
    const dir = join(root, 'knowledge', 'q', 'execution');
    mkdirSync(dir, { recursive: true });
    const login = entry('/entrar', 'Entrar', '2026-10-01');
    writeFileSync(join(dir, 'a.json'), JSON.stringify([login, entry('/x', 'Velho', '2026-10-02')]));
    writeFileSync(join(dir, 'b.json'), JSON.stringify([login, entry('/y', 'Novo', '2026-11-01')]));
    const hints = executionHints(root, 'q', ['a', 'b'], 2);
    expect(hints).toEqual([
      "/y: await page.getByRole('button', { name: 'Novo', exact: true }).click();",
      "/x: await page.getByRole('button', { name: 'Velho', exact: true }).click();",
    ]);
    expect(executionHints(root, 'q', ['a', 'b']).filter((h) => h.startsWith('/entrar')).length).toBe(1);
  });
});
