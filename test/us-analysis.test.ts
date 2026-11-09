import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { latestUsAnalysis, saveUsAnalysis } from '../src/analysis/us-analysis.ts';
import { buildContextPackage } from '../src/context/package.ts';
import { loadConfig } from '../src/config/load.ts';
import { boundPrompt, missionCommand, SANCTUM_TOOLS } from '../src/live/agents.ts';
import { DigestCache, type JiraDigest } from '../src/sources/digest.ts';
import { openDb, type Db } from '../src/state/db.ts';

const digest: JiraDigest = {
  key: 'FIX-42', title: 'Filtro por nome', type: 'Story', status: 'Em teste', components: [], labels: [],
  summary: 'Filtra alunos pelo nome', acceptanceCriteria: ['CA01: filtra por parte do nome', 'CA02: mensagem quando vazio'],
  businessRules: [], roles: [], openQuestions: [], links: [], attachments: [], figma: [], confluence: [], comments: [], environmentHints: [],
};

const analysis = (over: Record<string, unknown> = {}) => ({
  issueKey: 'FIX-42', cardVersion: 'v1',
  summary: 'Administrador filtra a lista de alunos pelo nome.',
  sources: ['card FIX-42', 'módulo alunos'],
  gaps: [{ criterion: 'CA01', kind: 'lacuna', text: 'Não diz o mínimo de caracteres para buscar' }],
  questions: [{ text: 'A busca começa com quantos caracteres?', options: ['1', '2', '3'], criterion: 'CA01' }],
  risks: [{ area: 'Relatório de alunos', text: 'Usa o mesmo endpoint de busca', regressionOf: 'FIX-10' }],
  improvements: [{ kind: 'ux', text: 'Manter o filtro ao voltar da ficha do aluno', why: 'Hoje o usuário perde a busca a cada aluno aberto' }],
  draftScenarios: [{
    code: 'CT-001', title: 'Filtra por parte do nome (CA01)', priority: 'P1', risk: 'MEDIUM', types: ['functional'],
    preconditions: 'admin; 3 alunos com "Ana" no nome', steps: ['digitar "an"'], expected: 'lista mostra só os 3 alunos com "Ana"',
  }],
  ...over,
});

let root: string;
let db: Db;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sanctum-analise-')); db = openDb(':memory:'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('análise da US (/analisar)', () => {
  it('grava, gera relatório e aponta o que o rascunho ainda não cobre do padrão', () => {
    const res = saveUsAnalysis(db, root, analysis(), { criteria: digest.acceptanceCriteria, linkedBugs: [] }, 'claude-code', new Date('2026-11-09T12:00:00Z'));
    expect(res.coverage?.uncovered).toEqual(['CA02: mensagem quando vazio']);
    expect(res.draftProblems.join(' ')).toMatch(/CA02/);
    expect(existsSync(res.report.md) && existsSync(res.report.html)).toBe(true);
    const html = readFileSync(res.report.html, 'utf8');
    expect(html).toMatch(/Perguntas para o PO/);
    expect(html).toMatch(/não são regra nem bug/);
    expect(latestUsAnalysis(db, 'FIX-42')).toMatchObject({ issueKey: 'FIX-42', report: 'reports/FIX-42/analise-FIX-42-20261109T120000.html' });
  });

  it('escapa HTML e recusa formato inválido', () => {
    const res = saveUsAnalysis(db, root, analysis({ summary: '<script>alert(1)</script> filtro' }), { criteria: [], linkedBugs: [] }, null);
    expect(readFileSync(res.report.html, 'utf8')).not.toMatch(/<script>alert/);
    expect(() => saveUsAnalysis(db, root, analysis({ improvements: [{ kind: 'ux', text: 'sem motivo' }] }), { criteria: [], linkedBugs: [] }, null)).toThrow();
  });

  it('context_build traz a última análise e avisa se o card mudou depois', () => {
    const config = loadConfig(join(import.meta.dirname, '..'));
    config.projects.fixture!.jiraKeys = ['FIX'];
    const cache = new DigestCache(db, root);
    cache.put('jira', 'FIX-42', 'v2', digest);
    saveUsAnalysis(db, root, analysis(), { criteria: [], linkedBugs: [] }, null);
    const pkg = buildContextPackage({ rootDir: root, config, db, cache, env: {} }, 'FIX-42');
    expect(pkg.analysis?.gaps[0]).toMatch(/CA01 \[lacuna\]/);
    expect(pkg.analysis?.draftScenarios).toEqual(['CT-001 P1/MEDIUM Filtra por parte do nome (CA01)']);
    expect(pkg.analysis?.stale).toMatch(/versão v1/);
  });

  it('painel lança a análise pelos dois agentes', () => {
    const card = { kind: 'card' as const, key: 'FIX-42' };
    expect(missionCommand(card, 'analyze')).toBe('/analisar FIX-42');
    expect(boundPrompt(card, 'analyze')).toMatch(/skills\/analisar\/SKILL\.md[\s\S]*us_analysis_save/);
    expect(SANCTUM_TOOLS).toContain('us_analysis_save');
  });
});
