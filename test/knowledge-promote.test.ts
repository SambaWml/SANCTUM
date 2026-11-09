import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadModules } from '../src/knowledge/modules.ts';
import { promoteStaging, proposeKnowledge, stagingSummary } from '../src/knowledge/staging.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sanctum-kp-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const obs = (statement: string) => ({ statement, kind: 'behavior' as const, status: 'OBSERVED' as const, confidence: 'HIGH' as const, source: { type: 'run' as const, reference: 'R1' } });

describe('conhecimento de produto: proposta → revisão humana → módulo', () => {
  it('o agente não pode declarar fonte manual (é só de humano)', () => {
    expect(() => proposeKnowledge(root, 'p', 'jornada', 'R1', [{ ...obs('regra dita na reunião'), kind: 'business_rule', status: 'DOCUMENTED', source: { type: 'manual', reference: 'eu' } }]))
      .toThrow(/manual/);
  });

  it('só promove staging marcado como revisado; depois o módulo carrega e o staging sai', () => {
    proposeKnowledge(root, 'p', 'jornada', 'R1', [obs('Dia só com aprofundamento entra no divisor da média')]);
    expect(stagingSummary(root, 'p')).toEqual([{ module: 'jornada', proposals: 1, reviewed: false }]);
    expect(() => promoteStaging(root, 'p', 'jornada', 'Jornada do aluno: calendário, sequência e desempenho')).toThrow(/reviewed: true/);

    const path = join(root, 'knowledge', 'p', '_staging', 'jornada.yaml');
    writeFileSync(path, stringify({ ...(parse(readFileSync(path, 'utf8')) as object), reviewed: true }));
    const r = promoteStaging(root, 'p', 'jornada', 'Jornada do aluno: calendário, sequência e desempenho');
    expect(r).toMatchObject({ promoted: 1, total: 1 });
    expect(existsSync(path)).toBe(false);
    const [loaded] = loadModules(root, 'p');
    expect(loaded!.error).toBeUndefined();
    expect(loaded!.module!.statements[0]!.statement).toMatch(/divisor/);
  });
});
