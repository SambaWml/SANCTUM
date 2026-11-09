import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, parseDocument, YAMLMap } from 'yaml';
import { z } from 'zod';
import { LOCAL_FILES } from './load.ts';
import { ENV_TYPES, EnvironmentsFile, ProjectsFile } from './schema.ts';

/**
 * Cadastro de ambiente pelo agente sem editar YAML à mão (auditoria de fluxo 09/11: cada cadastro
 * virava pedido de permissão de escrita de arquivo). Só ACRESCENTA: ambiente novo, papel novo num
 * ambiente existente, projeto novo. Nunca altera o que já existe e nunca liga allowDataCreation —
 * liberar criação de dados é decisão do usuário. Senha só como referência ao .env.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'use letras minúsculas, números e hífen');
const envVar = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'nome de variável em MAIÚSCULAS (ex.: LOJA_HML_ADMIN_PASSWORD)');

export const EnvRegisterInput = z.strictObject({
  id,
  project: id,
  projectName: z.string().min(1).optional().describe('obrigatório se o projeto ainda não existe'),
  jiraKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9]+$/)).optional(),
  type: z.enum(ENV_TYPES),
  baseUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), 'só http(s)'),
  mfa: z.boolean().optional(),
  captcha: z.boolean().optional(),
  roles: z.record(id, z.strictObject({ username: z.string().min(1), envVar: envVar.describe('nome da variável do .env com a senha') })).optional(),
  note: z.string().min(5).max(300).describe('por que/quem pediu, vira comentário no YAML'),
});
export type EnvRegisterInput = z.infer<typeof EnvRegisterInput>;

export interface EnvRegisterResult {
  environment: string; created: boolean; projectCreated: boolean;
  rolesAdded: string[]; rolesKept: string[];
  /** Variáveis que o usuário precisa preencher no .env (nunca no chat). */
  fillInDotEnv: string[];
  next: string;
}

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

export function registerEnvironment(rootDir: string, raw: unknown, env: NodeJS.ProcessEnv = process.env): EnvRegisterResult {
  const input = EnvRegisterInput.parse(raw);
  // Grava em config/*.local.yaml (fora do git: URLs e usuários de cliente não vão para o repositório).
  const envPath = join(rootDir, 'config', LOCAL_FILES.environments);
  const projPath = join(rootDir, 'config', LOCAL_FILES.projects);
  const envDoc = parseDocument(existsSync(envPath) ? readFileSync(envPath, 'utf8') : '# Ambientes desta instalação (fora do git).\nenvironments: {}\n');
  const projDoc = parseDocument(existsSync(projPath) ? readFileSync(projPath, 'utf8') : '# Projetos desta instalação (fora do git).\nprojects: {}\n');
  // Base versionado: só o que é da própria ferramenta; não muda por aqui.
  const baseOf = (file: string) => { const p = join(rootDir, 'config', file); return existsSync(p) ? parseDocument(readFileSync(p, 'utf8')) : null; };
  const baseEnv = baseOf('environments.yaml');
  const baseProj = baseOf('projects.yaml');
  if (baseEnv?.hasIn(['environments', input.id]) && !envDoc.hasIn(['environments', input.id])) {
    throw new Error(`ambiente ${input.id} é da própria ferramenta (config/environments.yaml): nada foi alterado`);
  }
  const today = new Date().toISOString().slice(0, 10);

  let projectCreated = false;
  if (!projDoc.hasIn(['projects', input.project]) && !baseProj?.hasIn(['projects', input.project])) {
    if (!input.projectName) throw new Error(`projeto ${input.project} não existe: informe projectName (e jiraKeys, se usa Jira)`);
    const node = projDoc.createNode({ name: input.projectName, jiraKeys: input.jiraKeys ?? [], language: 'pt' }) as YAMLMap;
    node.commentBefore = ` ${input.note} (cadastrado pelo agente em ${today})`;
    projDoc.setIn(['projects', input.project], node);
    projectCreated = true;
  }

  const rolesAdded: string[] = [];
  const rolesKept: string[] = [];
  const roleNode = (r: { username: string; envVar: string }) => ({ username: r.username, password: { env: r.envVar } });
  const existing = envDoc.getIn(['environments', input.id]);
  const created = !isMap(existing);
  if (created) {
    const roles: Record<string, unknown> = {};
    for (const [name, r] of Object.entries(input.roles ?? {})) { roles[name] = roleNode(r); rolesAdded.push(name); }
    const node = envDoc.createNode({
      project: input.project, type: input.type, baseUrl: input.baseUrl,
      // Sempre false: liberar criação de dados é decisão do usuário, editando o arquivo.
      allowDataCreation: false, mfa: input.mfa ?? false, captcha: input.captcha ?? false, roles,
    }) as YAMLMap;
    node.commentBefore = ` ${input.note} (cadastrado pelo agente em ${today}; criação de dados desligada até o usuário liberar)`;
    envDoc.setIn(['environments', input.id], node);
  } else {
    if (envDoc.getIn(['environments', input.id, 'project']) !== input.project) {
      throw new Error(`ambiente ${input.id} já existe em outro projeto: nada foi alterado`);
    }
    for (const [name, r] of Object.entries(input.roles ?? {})) {
      if (envDoc.hasIn(['environments', input.id, 'roles', name])) { rolesKept.push(name); continue; }
      envDoc.setIn(['environments', input.id, 'roles', name], envDoc.createNode(roleNode(r)));
      rolesAdded.push(name);
    }
  }

  // Valida o resultado inteiro antes de gravar (mesmo schema do loadConfig).
  const envCheck = EnvironmentsFile.safeParse(envDoc.toJS());
  const projCheck = ProjectsFile.safeParse(projDoc.toJS());
  if (!envCheck.success || !projCheck.success) {
    const issues = [...(envCheck.error?.issues ?? []), ...(projCheck.error?.issues ?? [])].map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`cadastro inválido, nada foi gravado: ${issues.join('; ')}`);
  }
  if (projectCreated) writeAtomic(projPath, projDoc.toString());
  if (created || rolesAdded.length) writeAtomic(envPath, envDoc.toString());

  const fillInDotEnv = Object.values(input.roles ?? {}).map((r) => r.envVar).filter((v, i, a) => !env[v] && a.indexOf(v) === i);
  return {
    environment: input.id, created, projectCreated, rolesAdded, rolesKept, fillInDotEnv,
    next: fillInDotEnv.length
      ? `peça ao usuário para preencher no .env: ${fillInDotEnv.join(', ')} (nunca no chat); depois config_reload`
      : 'rode config_reload',
  };
}
