import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ModuleFile, projectDir } from './modules.ts';

export const ProposedStatement = z.strictObject({
  statement: z.string().min(5),
  kind: z.enum(['business_rule', 'behavior', 'permission', 'risk', 'regression']),
  status: z.enum(['DOCUMENTED', 'CONFIRMED', 'OBSERVED', 'INFERRED', 'SUSPECTED']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  source: z.strictObject({
    type: z.enum(['jira', 'confluence', 'figma', 'manual', 'run']),
    reference: z.string().min(1),
    version: z.string().optional(),
  }),
});
export type ProposedStatement = z.infer<typeof ProposedStatement>;

export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

/**
 * Propostas de conhecimento ficam em knowledge/<projeto>/_staging/<módulo>.yaml até revisão humana.
 * As mesmas regras de proveniência dos módulos valem aqui: nada entra em staging que não
 * poderia entrar no módulo.
 */
export function proposeKnowledge(rootDir: string, project: string, module: string, runId: string, statements: ProposedStatement[]) {
  const problems: string[] = [];
  statements.forEach((s, i) => {
    if (s.source.type === 'run' && s.source.reference !== runId) {
      problems.push(`[${i}] source run deve ser o run atual (${runId})`);
    }
    // "manual" é o que um humano afirmou: o agente não pode alegar (viraria regra sem fonte).
    if (s.source.type === 'manual') problems.push(`[${i}] fonte manual é só de revisão humana; use jira/confluence/figma com a referência ou run (OBSERVED)`);
  });
  const check = ModuleFile.safeParse({ module, summary: 'validação de proposta', source: { type: 'run', reference: runId }, statements });
  if (!check.success) problems.push(...check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  if (problems.length) throw new KnowledgeError(`proposta recusada:\n- ${problems.join('\n- ')}`);

  const dir = join(projectDir(rootDir, project), '_staging');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${module}.yaml`);
  const current = existsSync(path) ? ((parse(readFileSync(path, 'utf8')) as { proposals?: unknown[] })?.proposals ?? []) : [];
  const known = new Set(current.map((p) => (p as ProposedStatement).statement));
  const fresh = statements.filter((s) => !known.has(s.statement));
  writeFileSync(path, stringify({ module, reviewed: false, proposals: [...current, ...fresh] }, { lineWidth: 0 }));
  return { file: `knowledge/${project}/_staging/${module}.yaml`, added: fresh.length, duplicates: statements.length - fresh.length };
}

/** Propostas pendentes por módulo (sanctum knowledge <projeto>). */
export function stagingSummary(rootDir: string, project: string) {
  const dir = join(projectDir(rootDir, project), '_staging');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => {
      const doc = parse(readFileSync(join(dir, f), 'utf8')) as { module: string; reviewed?: boolean; proposals?: unknown[] };
      return { module: doc.module, proposals: doc.proposals?.length ?? 0, reviewed: doc.reviewed === true };
    });
}

/**
 * Promoção feita por humano: só staging com `reviewed: true` (o humano revisou e editou o arquivo)
 * entra em knowledge/<projeto>/modules/<módulo>.yaml, com as mesmas regras de proveniência.
 * Depois disso o Context Package passa a entregar o módulo ao agente.
 */
export function promoteStaging(rootDir: string, project: string, module: string, summary: string) {
  const stagingPath = join(projectDir(rootDir, project), '_staging', `${module}.yaml`);
  if (!existsSync(stagingPath)) throw new KnowledgeError(`não há staging para ${module}`);
  const staged = parse(readFileSync(stagingPath, 'utf8')) as { reviewed?: boolean; proposals?: ProposedStatement[] };
  if (staged.reviewed !== true) {
    throw new KnowledgeError(`${module}: revise o arquivo _staging/${module}.yaml e marque reviewed: true antes de promover`);
  }
  const modulesDir = join(projectDir(rootDir, project), 'modules');
  mkdirSync(modulesDir, { recursive: true });
  const modulePath = join(modulesDir, `${module}.yaml`);
  const current = existsSync(modulePath) ? (parse(readFileSync(modulePath, 'utf8')) as ModuleFile) : undefined;
  const known = new Set((current?.statements ?? []).map((s) => s.statement));
  const fresh = (staged.proposals ?? []).filter((p) => !known.has(p.statement));
  const next = {
    module,
    aliases: current?.aliases ?? [],
    summary: current?.summary ?? summary,
    source: current?.source ?? { type: 'manual' as const, reference: `revisão humana do staging (${new Date().toISOString().slice(0, 10)})` },
    statements: [...(current?.statements ?? []), ...fresh],
  };
  const check = ModuleFile.safeParse(next);
  if (!check.success) {
    throw new KnowledgeError(`promoção recusada:\n- ${check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n- ')}`);
  }
  writeFileSync(modulePath, stringify(check.data, { lineWidth: 0 }));
  rmSync(stagingPath);
  return { file: `knowledge/${project}/modules/${module}.yaml`, promoted: fresh.length, total: next.statements.length };
}

/**
 * O que os testes anteriores aprenderam e ainda não foi revisado. Antes só o conhecimento promovido
 * voltava para o agente, e nada era promovido (auditoria 12/11: 100+ aprendizados parados em 13
 * módulos): agora entra no Context Package marcado como "não revisado".
 */
export function loadStaging(rootDir: string, project: string): { module: string; proposals: ProposedStatement[] }[] {
  const dir = join(projectDir(rootDir, project), '_staging');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).flatMap((f) => {
    try {
      const doc = parse(readFileSync(join(dir, f), 'utf8')) as { module?: string; proposals?: ProposedStatement[] };
      return doc?.module ? [{ module: doc.module, proposals: doc.proposals ?? [] }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Regra afirmada pelo usuário (resposta a uma pergunta do modo descoberta). É o único caminho pelo
 * qual uma fonte "manual" entra sem edição de arquivo — e só é chamado por question_answer, que
 * exige a confirmação do usuário a cada chamada.
 */
export function addUserRule(rootDir: string, project: string, module: string, statement: string, reference: string): { file: string; added: boolean } {
  const dir = join(projectDir(rootDir, project), '_staging');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${module}.yaml`);
  const current = existsSync(path) ? ((parse(readFileSync(path, 'utf8')) as { proposals?: ProposedStatement[] })?.proposals ?? []) : [];
  const entry: ProposedStatement = { statement, kind: 'business_rule', status: 'CONFIRMED', confidence: 'HIGH', source: { type: 'manual', reference } };
  const check = ModuleFile.safeParse({ module, summary: 'validação de regra do usuário', source: entry.source, statements: [entry] });
  if (!check.success) throw new KnowledgeError(`regra recusada: ${check.error.issues.map((i) => i.message).join('; ')}`);
  const added = !current.some((p) => p.statement === statement);
  if (added) writeFileSync(path, stringify({ module, reviewed: false, proposals: [...current, entry] }, { lineWidth: 0 }));
  return { file: `knowledge/${project}/_staging/${module}.yaml`, added };
}
