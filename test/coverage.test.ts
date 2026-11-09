import { describe, expect, it } from 'vitest';
import { planCoverage } from '../src/state/coverage.ts';

describe('cobertura dos critérios pelo plano', () => {
  const criteria = [
    'CA01: o aluno vê os contadores de aprofundamentos no cartão da meta',
    'CA02 - abas Reforços e Aprofundamentos com contadores consistentes',
    'CA 3 — tabela "Cumpridos nesta meta" com 7 colunas',
    'Quando não houver itens, exibir "Nenhum aprofundamento"',
  ];

  it('liga cada critério aos cenários que citam o mesmo código, em qualquer grafia', () => {
    const cov = planCoverage(criteria, [
      { code: 'CT-001', title: 'CA01: contadores no cartão' },
      { code: 'CT-002', title: 'Abas consistentes', expected: 'conforme CA-02, só cumpridos' },
      { code: 'CT-003', title: 'CA1 com outra meta' },
    ]);
    expect(cov.covered).toEqual(['CA01 → CT-001, CT-003', 'CA02 → CT-002']);
    expect(cov.uncovered).toEqual(['CA03: tabela "Cumpridos nesta meta" com 7 colunas']);
    expect(cov.withoutCode).toBe(1);
  });

  it('CA1 não conta como CA10 nem o contrário', () => {
    const cov = planCoverage(['CA10: exportar relatório'], [{ code: 'CT-001', title: 'CA1: filtro' }]);
    expect(cov.uncovered).toEqual(['CA10: exportar relatório']);
  });
});
