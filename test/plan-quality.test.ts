import { describe, expect, it } from 'vitest';
import { checkPlanQuality, type PlanScenario } from '../src/state/plan-quality.ts';

const ok = (code: string, over: Partial<PlanScenario> = {}): PlanScenario => ({
  code, title: `${code} CA01: contadores no cartão da meta`, priority: 'P1', risk: 'MEDIUM', types: ['functional'],
  preconditions: 'aluno-b com meta atual e 2 aprofundamentos cumpridos', steps: ['abrir o Arquivo'],
  expected: 'cartão mostra "0 reforços • 2 aprofundamentos"', ...over,
});
const ctx = { mode: 'manual', criteria: ['CA01: contadores no cartão'], linkedBugs: [], waivers: [] };

describe('padrão Sanctum de plano', () => {
  it('plano completo passa', () => {
    expect(checkPlanQuality([ok('CT-001')], ctx).problems).toEqual([]);
  });

  it('cobra pré-condição e esperado verificável', () => {
    const p = checkPlanQuality([ok('CT-001', { preconditions: '' }), ok('CT-002', { expected: 'funciona corretamente' }), ok('CT-003', { expected: 'ok' })], ctx).problems.join('\n');
    expect(p).toMatch(/sem pré-condição[^\n]*CT-001/);
    expect(p).toMatch(/não verificável[^\n]*CT-002, CT-003/);
  });

  it('critério sem cenário é recusado; dispensa com motivo aceita e vira nota', () => {
    const c = { ...ctx, criteria: ['CA01: contadores', 'CA02: abas consistentes'] };
    expect(checkPlanQuality([ok('CT-001')], c).problems.join(' ')).toMatch(/critério sem cenário[\s\S]*CA02/);
    const waived = checkPlanQuality([ok('CT-001')], { ...c, waivers: [{ item: 'CA02', reason: 'PO tirou do escopo no comentário de 03/11' }] });
    expect(waived.problems).toEqual([]);
    expect(waived.notes.join(' ')).toMatch(/dispensa CA02/);
  });

  it('risco HIGH sem negativo/permissão/validação é recusado', () => {
    expect(checkPlanQuality([ok('CT-001', { risk: 'HIGH' })], ctx).problems.join(' ')).toMatch(/risco HIGH/);
    expect(checkPlanQuality([ok('CT-001', { risk: 'HIGH' }), ok('CT-002', { types: ['permission'] })], ctx).problems).toEqual([]);
  });

  it('bug ligado ao card pede cenário de regressão citando a chave', () => {
    const c = { ...ctx, linkedBugs: ['GURUJA-9300'] };
    expect(checkPlanQuality([ok('CT-001')], c).problems.join(' ')).toMatch(/GURUJA-9300/);
    expect(checkPlanQuality([ok('CT-001'), ok('CT-002', { title: 'CA01 regressão GURUJA-9300: pendentes não somam', types: ['regression'] })], c).problems).toEqual([]);
  });

  it('run_complete exige EXP executado (ou o motivo) e o plan_save recusa plano fora do padrão', async () => {
    const { join } = await import('node:path');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { loadConfig } = await import('../src/config/load.ts');
    const { createServer } = await import('../src/mcp/server.ts');
    const { Redactor } = await import('../src/security/redact.ts');
    const { openDb } = await import('../src/state/db.ts');
    const { StateStore } = await import('../src/state/store.ts');
    const config = loadConfig(join(import.meta.dirname, '..'));
    const db = openDb(':memory:');
    const store = new StateStore(db, config);
    const server = createServer({ store, redactor: new Redactor(), rootDir: join(import.meta.dirname, '..'), config, db });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'antigravity-client', version: '1' });
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text;

    const runId = JSON.parse(await call('run_start', { issueKey: 'FIX-70', env: 'fixture-local', mode: 'manual' })).runId as string;
    expect(await call('plan_save', { runId, scenarios: [{ ...ok('CT-001'), preconditions: undefined }] })).toMatch(/fora do padrão Sanctum[\s\S]*sem pré-condição/);
    await call('plan_save', { runId, scenarios: [ok('CT-001')] });
    store.approvePlan(runId);
    store.startScenario(runId, 'CT-001');
    store.recordVerification(runId, 'CT-001', { kind: 'network', description: 'GET contadores 200', passed: true });
    store.completeScenario(runId, 'CT-001', { status: 'PASSED' });
    expect(await call('run_complete', { runId, recommendation: 'APROVADO', summary: 'contadores ok' })).toMatch(/ao menos 1 cenário\(s\) EXP/);
    const exp = store.addExploratory(runId, { ...ok('X'), title: 'Contador com meta sem aprofundamentos', priority: 'P2', risk: 'LOW' });
    store.startScenario(runId, exp.code);
    store.recordVerification(runId, exp.code, { kind: 'ui', description: 'contador zero', passed: true });
    store.completeScenario(runId, exp.code, { status: 'PASSED' });
    expect(JSON.parse(await call('run_complete', { runId, recommendation: 'APROVADO', summary: 'contadores ok' })).status).toBe('COMPLETED');
  });

  it('reteste cobra só pré-condição e esperado (repete o que falhou)', () => {
    const c = { ...ctx, mode: 'retest', criteria: ['CA01: x', 'CA02: y'], linkedBugs: ['GURUJA-1'] };
    expect(checkPlanQuality([ok('CT-002', { risk: 'HIGH' })], c).problems).toEqual([]);
  });
});
