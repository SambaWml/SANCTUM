import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { deriveMapFromExecution, loadSystemMap, mapIndex, routeKey, saveSystemMap } from '../src/knowledge/system-map.ts';
import { createHarness, type Harness } from './harness.ts';

describe('mapa do sistema', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sanctum-mapa-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('acrescenta sem apagar: tela nova entra, tela conhecida ganha o que foi visto, e o que foi visitado sai de "falta visitar"', () => {
    saveSystemMap(root, 'clinica', {
      screens: [{ route: '/agenda', name: 'Agenda do dia', shows: ['consultas por horário'], actions: [{ name: 'Nova consulta' }], roles: { recepcionista: 'ok' } }],
      entities: ['Consulta'], unvisited: ['/pacientes', '/financeiro'],
    }, new Date('2026-11-12T12:00:00Z'));
    const second = saveSystemMap(root, 'clinica', {
      screens: [
        { route: '/agenda', name: 'Agenda do dia', shows: ['filtro por médico'], actions: [{ name: 'Cancelar', risk: 'RED' }], roles: { medico: 'unknown' } },
        { route: '/pacientes/1043', name: 'Ficha do paciente', apis: ['GET /api/patients/:id'] },
        { route: '/financeiro', name: 'Financeiro', roles: { recepcionista: 'blocked' } },
      ],
      entities: ['Paciente'],
    }, new Date('2026-11-13T12:00:00Z'));
    expect(second.added).toEqual(['/pacientes/:id', '/financeiro']);
    expect(second.updated).toEqual(['/agenda']);
    const map = loadSystemMap(root, 'clinica')!;
    const agenda = map.screens.find((s) => s.route === '/agenda')!;
    expect(agenda.shows).toEqual(['consultas por horário', 'filtro por médico']);
    expect(agenda.actions.map((a) => a.name)).toEqual(['Nova consulta', 'Cancelar']);
    expect(agenda.roles).toEqual({ recepcionista: 'ok', medico: 'unknown' });
    expect(agenda.lastSeen).toBe('2026-11-13');
    expect(map.entities).toEqual(['Consulta', 'Paciente']);
    expect(map.unvisited).toEqual(['/pacientes']);
    const index = mapIndex(map, new Date('2026-11-13T12:00:00Z'));
    expect(index.riskyActions).toEqual(['/agenda: Cancelar']);
    expect(index.blockedFor).toEqual(['/financeiro (recepcionista)']);
  });

  it('mapa envelhece: tela não vista há mais de 30 dias é marcada; ids na rota não criam telas diferentes', () => {
    saveSystemMap(root, 'clinica', { screens: [{ route: '/agenda', name: 'Agenda' }] }, new Date('2026-09-01T12:00:00Z'));
    expect(mapIndex(loadSystemMap(root, 'clinica')!, new Date('2026-11-12T12:00:00Z')).screens).toEqual(['/agenda — Agenda [vista há mais de 30 dias]']);
    expect(routeKey('/pacientes/1043/consultas/7?aba=1')).toBe('/pacientes/:id/consultas/:id');
  });

  it('projeto já testado: a primeira versão sai das rotas e ações validadas, marcada como deduzida', () => {
    mkdirSync(join(root, 'knowledge', 'clinica', 'execution'), { recursive: true });
    writeFileSync(join(root, 'knowledge', 'clinica', 'execution', 'agenda.json'), JSON.stringify([
      { route: '/agenda', action: 'click', target: { role: 'button', name: 'Nova consulta' }, playwright: 'x', scenario: 'CT-001', validatedIn: ['r1'], lastSeen: '2026-11-01' },
      { route: '/agenda', action: 'fill', target: { label: 'Busca' }, playwright: 'x', scenario: 'CT-001', validatedIn: ['r1'], lastSeen: '2026-11-01' },
      { route: '/pacientes/12', action: 'click', target: { role: 'tab', name: 'Histórico 3' }, playwright: 'x', scenario: 'CT-002', validatedIn: ['r1'], lastSeen: '2026-11-02' },
    ]));
    const derived = deriveMapFromExecution(root, 'clinica')!;
    expect(derived.screens.map((s) => s.route)).toEqual(['/agenda', '/pacientes/:id']);
    expect(derived.screens[0]!.actions).toEqual([{ name: 'Nova consulta' }]);
    saveSystemMap(root, 'clinica', derived);
    expect(mapIndex(loadSystemMap(root, 'clinica')!).screens[0]).toMatch(/\[deduzida\]/);
    expect(deriveMapFromExecution(root, 'vazio')).toBeNull();
  });
});

describe('modo descoberta ponta a ponta (fixture, ferramentas reais)', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it('reconhecimento só leitura → mapa → perguntas → plano; e o próximo teste já recebe o que foi aprendido', async () => {
    const key = 'EXPLORA-202611121030';
    await h.ok('digest_put', { source: 'jira', key, version: '1', digest: {
      key, title: 'Conhecer o cadastro de alunos', type: 'Missão exploratória', status: 'Sem card', components: [], labels: [], summary: 'Explorar o app de alunos',
      acceptanceCriteria: [], businessRules: [], roles: ['admin'], openQuestions: [], links: [], attachments: [], figma: [], confluence: [], comments: [], environmentHints: [h.fixture.url],
    } });
    const runId = (await h.ok('run_start', { issueKey: key, env: 'fixture-local', mode: 'explore' })).runId as string;

    // 1. Antes do plano o navegador abre só para leitura: logar e navegar pode; criar dado não.
    await h.ok('browser_open', { runId, role: 'admin' });
    await h.ok('act', { action: 'fill', target: { label: 'Usuário' }, valueRef: 'role:admin.username' });
    await h.ok('act', { action: 'fill', target: { label: 'Senha' }, valueRef: 'role:admin.password' });
    await h.ok('act', { action: 'click', target: { role: 'button', name: 'Entrar' } });
    await h.ok('snapshot', {});
    // Nem abrir o formulário de criação: o que cria ou altera dado fica para depois do plano aprovado.
    const blocked = await h.call('act', { action: 'click', target: { role: 'button', name: 'Novo aluno' } });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/reconhecimento é só leitura/);
    // E não existe aprovação avulsa antes do plano.
    const forced = await h.call('act_approved', { action: 'click', target: { role: 'button', name: 'Novo aluno' }, justification: 'quero ver o formulário de cadastro' });
    expect(forced.text).toMatch(/reconhecimento é só leitura/);

    // 2. O plano não é aceito sem mapa nem com pergunta em aberto.
    const scenario = { code: 'CT-001', title: 'Linha de base: login do admin', priority: 'P2', risk: 'LOW', types: ['functional'], preconditions: 'admin cadastrado', steps: ['logar'], expected: 'lista de alunos visível após o login' };
    const charters = [{ target: 'Lista de alunos: estados de erro', tours: ['voltar e recarregar'] }, { target: 'Cadastro: validações', tours: ['voltar e recarregar'] }];
    const noMap = await h.call('plan_save', { runId, scenarios: [scenario], charters });
    expect(noMap.text).toMatch(/ainda não tem mapa do sistema/);
    const saved = await h.ok('system_map_save', { runId, screens: [
      { route: '/', name: 'Lista de alunos', shows: ['tabela de alunos'], actions: [{ name: 'Novo aluno' }, { name: 'Salvar', risk: 'YELLOW' }], apis: ['GET /api/students', 'POST /api/students'], roles: { admin: 'ok' } },
    ], entities: ['Aluno'], unvisited: ['/relatorios'] });
    expect(saved).toMatchObject({ screens: 1, added: ['/'] });

    const asked = await h.ok('question_ask', { runId, questions: [{ module: 'alunos', text: 'Nome de aluno duplicado é permitido?', options: ['sim', 'não'], about: 'Lista de alunos' }] });
    const qid = asked.open[0].id as number;
    expect((await h.call('plan_save', { runId, scenarios: [scenario], charters })).text).toMatch(/1 pergunta\(s\) ao usuário em aberto/);

    // 3. A resposta do usuário vira regra com fonte.
    expect((await h.call('question_answer', { runId, id: qid, answer: 'não' })).text).toMatch(/informe rule/);
    const answered = await h.ok('question_answer', { runId, id: qid, answer: 'não', rule: 'Não pode haver dois alunos com o mesmo nome' });
    expect(answered).toMatchObject({ status: 'ANSWERED', stillOpen: 0 });
    const staging = parse(readFileSync(join(h.root, 'knowledge', 'fixture', '_staging', 'alunos.yaml'), 'utf8')) as { proposals: { statement: string; status: string; source: { type: string; reference: string } }[] };
    expect(staging.proposals[0]).toMatchObject({ statement: 'Não pode haver dois alunos com o mesmo nome', status: 'CONFIRMED', source: { type: 'manual' } });
    expect(staging.proposals[0]!.source.reference).toMatch(/^usuário, \d{4}-\d{2}-\d{2}/);

    // 4. Com mapa e respostas, o plano entra.
    expect((await h.ok('plan_save', { runId, scenarios: [scenario], charters })).status).toBe('AWAITING_APPROVAL');

    // 5. Memória: o contexto de uma nova missão no mesmo projeto já traz o mapa e a regra aprendida.
    const ctx = parse((await h.call('context_build', { issueKey: key, project: 'fixture' })).text);
    expect(ctx.systemMap.screens).toEqual(['/ — Lista de alunos']);
    expect(ctx.systemMap.unvisited).toEqual(['/relatorios']);
    expect(ctx.knowledge.unreviewed[0].statements[0]).toBe('[business_rule/CONFIRMED] Não pode haver dois alunos com o mesmo nome');
  });
});
