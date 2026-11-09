import { z } from 'zod';

export const GUARD_LEVELS = ['GREEN', 'YELLOW', 'RED'] as const;
export const ENV_TYPES = ['local', 'dev', 'staging', 'prod'] as const;
export const MUTATION_MODES = ['flag', 'block'] as const;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'use letras minúsculas, números e hífen');

/** `{ env: NOME }` — valor lido do ambiente (.env). */
export const EnvRef = z.strictObject({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) });
export type EnvRef = z.infer<typeof EnvRef>;

/** Literal ou referência a variável de ambiente. */
export const ConfigValue = z.union([z.string().min(1), EnvRef]);
export type ConfigValue = z.infer<typeof ConfigValue>;

const Role = z.strictObject({
  username: ConfigValue,
  // Senha literal no YAML é rejeitada: só referência ao .env.
  password: EnvRef,
});

const Environment = z.strictObject({
  project: id,
  type: z.enum(ENV_TYPES),
  baseUrl: ConfigValue,
  allowDataCreation: z.boolean(),
  mfa: z.boolean().default(false),
  captcha: z.boolean().default(false),
  roles: z.record(id, Role),
  // Trechos de caminho que não contam como alteração (ex.: leitura via POST do projeto).
  mutationIgnore: z.array(z.string().min(1)).default([]),
  notes: z.string().optional(),
});
export type Environment = z.infer<typeof Environment>;

export const EnvironmentsFile = z.strictObject({
  environments: z.record(id, Environment),
});

const Project = z.strictObject({
  name: z.string().min(1),
  jiraKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9]+$/)),
  language: z.enum(['pt', 'en']),
});
export type Project = z.infer<typeof Project>;

export const ProjectsFile = z.strictObject({
  projects: z.record(id, Project),
});

const level = z.enum(GUARD_LEVELS);

export const PolicyFile = z.strictObject({
  guard: z.strictObject({
    allowedLevels: z.strictObject({
      local: z.array(level),
      dev: z.array(level),
      staging: z.array(level),
      prod: z.array(level).refine((l) => l.every((x) => x === 'GREEN'), 'prod só pode permitir GREEN'),
    }),
    yellowKeywords: z.array(z.string().min(1)),
    redKeywords: z.array(z.string().min(1)),
    mutationPolicy: z
      .strictObject({
        local: z.enum(MUTATION_MODES),
        dev: z.enum(MUTATION_MODES),
        staging: z.enum(MUTATION_MODES),
        prod: z.literal('block'),
      })
      .default({ local: 'flag', dev: 'flag', staging: 'flag', prod: 'block' }),
    mutationIgnore: z.array(z.string().min(1)).default([]),
  }),
  redaction: z.strictObject({
    extraSensitiveKeys: z.array(z.string().min(1)),
    maskSelectors: z.array(z.string().min(1)),
  }),
  execution: z.strictObject({
    batchSize: z.strictObject({
      HIGH: z.number().int().positive(),
      MEDIUM: z.number().int().positive(),
      LOW: z.number().int().positive(),
    }),
  }),
  automation: z.strictObject({
    maxFixAttempts: z.number().int().min(1).max(10),
  }),
  evidence: z
    .strictObject({
      // always: grava a sessão do navegador inteira (capítulos por cenário); off: não grava.
      video: z.enum(['always', 'off']),
      // Retenção de vídeo/trace (sanctum storage). PNG, .txt e relatórios nunca saem;
      // runs/_* (pastas montadas à mão) nunca são tocadas.
      retention: z
        .strictObject({
          videoDays: z.number().int().min(1),
          traceDays: z.number().int().min(1),
          // Vídeo de run com PRODUCT_BUG e trace do cenário com bug ficam mais tempo.
          bugDays: z.number().int().min(1),
          maxStorageGB: z.number().positive(),
        })
        .default({ videoDays: 14, traceDays: 14, bugDays: 60, maxStorageGB: 10 }),
    })
    .default({ video: 'always', retention: { videoDays: 14, traceDays: 14, bugDays: 60, maxStorageGB: 10 } }),
});
export type Policy = z.infer<typeof PolicyFile>;

export interface Config {
  projects: Record<string, Project>;
  environments: Record<string, Environment>;
  policy: Policy;
}
