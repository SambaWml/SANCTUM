import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import {
  EnvironmentsFile,
  PolicyFile,
  ProjectsFile,
  type Config,
  type ConfigValue,
  type EnvRef,
} from './schema.ts';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuração inválida:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

function readYaml<S extends z.ZodType>(path: string, schema: S, problems: string[]): z.infer<S> | undefined {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    problems.push(`${path}: ${(err as Error).message}`);
    return undefined;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${path}: ${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

/**
 * Projetos e ambientes reais de cada instalação ficam em `*.local.yaml` (fora do git: URLs e
 * usuários de cliente); os arquivos base trazem só o que é da ferramenta (fixture, painel).
 * O local acrescenta ao base; mesmo id no local substitui o do base.
 */
export const LOCAL_FILES = { projects: 'projects.local.yaml', environments: 'environments.local.yaml' } as const;

function readMerged<S extends z.ZodType>(dir: string, base: string, local: string, schema: S, problems: string[]): z.infer<S> | undefined {
  const a = readYaml(join(dir, base), schema, problems) as Record<string, Record<string, unknown>> | undefined;
  if (!existsSync(join(dir, local))) return a as z.infer<S> | undefined;
  const b = readYaml(join(dir, local), schema, problems) as Record<string, Record<string, unknown>> | undefined;
  if (!a || !b) return undefined;
  const key = Object.keys(a)[0]!;
  return { ...a, [key]: { ...a[key], ...b[key] } } as z.infer<S>;
}

/** Carrega e valida config/*.yaml (+ *.local.yaml). Lança ConfigError com todos os problemas encontrados. */
export function loadConfig(rootDir: string): Config {
  const dir = join(rootDir, 'config');
  const problems: string[] = [];
  const projects = readMerged(dir, 'projects.yaml', LOCAL_FILES.projects, ProjectsFile, problems);
  const environments = readMerged(dir, 'environments.yaml', LOCAL_FILES.environments, EnvironmentsFile, problems);
  const policy = readYaml(join(dir, 'qa-policy.yaml'), PolicyFile, problems);

  if (projects && environments) {
    for (const [envId, env] of Object.entries(environments.environments)) {
      if (!projects.projects[env.project]) {
        problems.push(`environments.${envId}.project: projeto "${env.project}" não existe em projects.yaml`);
      }
    }
  }
  if (problems.length > 0 || !projects || !environments || !policy) throw new ConfigError(problems);

  return { projects: projects.projects, environments: environments.environments, policy };
}

export function isEnvRef(value: ConfigValue): value is EnvRef {
  return typeof value === 'object';
}

/** Resolve um valor de config; undefined se a variável referenciada não estiver definida. */
export function resolveValue(value: ConfigValue, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isEnvRef(value)) return value;
  const resolved = env[value.env];
  return resolved === undefined || resolved === '' ? undefined : resolved;
}

/** Nomes de todas as variáveis de ambiente referenciadas pela config. */
export function referencedEnvVars(config: Config): string[] {
  const names = new Set<string>();
  for (const env of Object.values(config.environments)) {
    if (isEnvRef(env.baseUrl)) names.add(env.baseUrl.env);
    for (const role of Object.values(env.roles)) {
      if (isEnvRef(role.username)) names.add(role.username.env);
      names.add(role.password.env);
    }
  }
  return [...names].sort();
}
