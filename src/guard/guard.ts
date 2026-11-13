import type { Environment, Policy } from '../config/schema.ts';
import type { GuardLevel } from './classify.ts';

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; needsApproval: boolean; reason: string };

/**
 * Aplica a política a uma ação já classificada:
 * - o tipo de ambiente limita os níveis (prod = só GREEN);
 * - YELLOW exige ambiente que permita criar/alterar dados;
 * - RED exige aprovação humana (ferramenta act_approved, sempre "ask" no Claude Code).
 */
export function decide(level: GuardLevel, env: Environment, policy: Policy, approved: boolean): GuardDecision {
  if (!policy.guard.allowedLevels[env.type].includes(level)) {
    return { allowed: false, needsApproval: false, reason: `ação ${level} não é permitida em ambiente ${env.type}` };
  }
  if (level === 'YELLOW' && !env.allowDataCreation) {
    return { allowed: false, needsApproval: false, reason: 'este ambiente não permite criar/alterar dados (allowDataCreation: false)' };
  }
  if (level === 'RED' && !approved) {
    return {
      allowed: false,
      needsApproval: true,
      reason: 'ação RED exige aprovação humana: peça ao usuário e use act_approved com os mesmos parâmetros e uma justificativa',
    };
  }
  return { allowed: true };
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Requisição que altera dados no servidor, percebida pela rede (não pelo texto do alvo).
 * Autenticação e leituras via POST configuradas (mutationIgnore da política e do ambiente) não contam.
 */
export function isMutation(method: string, path: string, env: Environment, policy: Policy): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  const p = path.toLowerCase();
  if (TELEMETRY_PATHS.some((re) => re.test(p))) return false;
  return ![...policy.guard.mutationIgnore, ...env.mutationIgnore].some((s) => p.includes(s.toLowerCase()));
}

/**
 * Telemetria servida no próprio domínio do app (medição de desempenho, analytics, relato de erro):
 * é POST, mas não cria nem altera dado do sistema testado. Auditoria 12/11: os 9 "dados criados" de
 * uma missão eram todos /cdn-cgi/rum (Cloudflare), e o agente teve de justificar um por um.
 */
const TELEMETRY_PATHS: RegExp[] = [
  /^\/cdn-cgi\//,                                   // Cloudflare (RUM, challenge, beacon)
  /^\/(_vercel|_next)\/(insights|speed-insights)\b/, // Vercel
  /\/(g|j|r)\/collect\b|\/gtag\/|\/gtm\.js/,         // Google Analytics / Tag Manager com proxy próprio
  /^\/(monitoring|sentry|_sentry|tunnel)\b.*envelope|\/api\/\d+\/envelope\b/, // Sentry (túnel)
  /\/(rum|beacon|telemetry|web-vitals|vitals)\/?$/,  // beacons genéricos
];
