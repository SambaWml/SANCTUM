import { planCoverage } from './coverage.ts';

/**
 * Padrão Sanctum de plano (09/11): o mesmo para qualquer agente. Medido nos runs: o Claude fazia
 * 14 cenários por card, 29% EXP, 95% com pré-condição; o Antigravity 10,5, 2% EXP, 60% com
 * pré-condição — e o Claude ficava devendo negativos/permissão. Conferido no plan_save
 * (recusa com a lista do que falta) e no run_complete (exploração).
 */

export interface PlanScenario {
  code: string; title: string; priority: string; risk: string; types: string[];
  preconditions?: string; steps: string[]; expected: string;
}
export interface PlanWaiver { item: string; reason: string }
export interface PlanContext {
  mode: string;
  criteria: string[];
  /** Bugs ligados ao card (links do digest): cada um pede cenário de regressão. */
  linkedBugs: string[];
  waivers: PlanWaiver[];
  /** Charters planejados (sessões exploratórias com foco e tempo). */
  charters?: number;
}
export interface PlanQuality { problems: string[]; notes: string[] }

/** "Esperado" que não dá para verificar com ferramenta. */
const VAGUE = /\b(funcion(a|ar|e)\s+(corretamente|normalmente|bem)|conforme\s+(o\s+)?esperado|como\s+esperado|deve\s+funcionar|sem\s+problemas?)\s*\.?$/i;
const NEGATIVE_TYPES = ['negative', 'permission', 'validation', 'security'];

export function checkPlanQuality(scenarios: PlanScenario[], ctx: PlanContext): PlanQuality {
  const problems: string[] = [];
  const notes: string[] = [];
  const waived = (item: string) => ctx.waivers.find((w) => w.item.toUpperCase() === item.toUpperCase() && w.reason.trim().length >= 5);
  for (const w of ctx.waivers) notes.push(`dispensa ${w.item}: ${w.reason}`);

  const noPre = scenarios.filter((s) => !s.preconditions?.trim()).map((s) => s.code);
  if (noPre.length) problems.push(`sem pré-condição (usuário/papel, dados e estado inicial): ${noPre.join(', ')}`);

  const vague = scenarios.filter((s) => VAGUE.test(s.expected.trim()) || s.expected.trim().length < 15).map((s) => s.code);
  if (vague.length) problems.push(`"esperado" não verificável (diga o que aparece na tela, a URL, a requisição/status ou o dado salvo): ${vague.join(', ')}`);

  // Exploração é sessão (charter), não roteiro: CT "exploratório" com passos fixos passava com "sem erros novos" (74 de 93).
  const scripted = scenarios.filter((s) => s.types.some((t) => /^explorat/i.test(t))).map((s) => s.code);
  if (scripted.length) problems.push(`exploração não é CT com roteiro: troque ${scripted.join(', ')} por charters no plano (charters: [{ target, tours, persona?, timeboxMin? }])`);

  // Reteste repete o que falhou: não precisa cobrir o card inteiro de novo.
  if (ctx.mode === 'retest') return { problems, notes };

  const minCharters = MIN_EXPLORATORY[ctx.mode] ?? 0;
  if (ctx.mode === 'explore' && (ctx.charters ?? 0) < minCharters && !waived('charters')) {
    problems.push(`exploratório pede ao menos ${minCharters} charters no plano (alvo, testes, tempo) — o foco da exploração é o que você aprova`);
  }

  const coverage = planCoverage(ctx.criteria, scenarios);
  const missing = coverage.uncovered.filter((u) => !waived(u.split(':')[0]!));
  if (missing.length) problems.push(`critério sem cenário (cite o CA no título; ou dispense com waivers: [{ item: "CA03", reason }]): ${missing.join(' | ')}`);

  const highRisk = scenarios.some((s) => s.risk === 'HIGH');
  const hasNegative = scenarios.some((s) => s.types.some((t) => NEGATIVE_TYPES.includes(t)));
  if (highRisk && !hasNegative && !waived('negative')) {
    problems.push('há área de risco HIGH e nenhum cenário negative/permission/validation (o que acontece com dado inválido, sem permissão, no limite?); ou dispense com waivers: [{ item: "negative", reason }]');
  }

  for (const bug of ctx.linkedBugs) {
    const cited = scenarios.some((s) => new RegExp(`\\b${bug}\\b`, 'i').test(`${s.title} ${s.expected} ${s.steps.join(' ')}`));
    if (!cited && !waived(bug)) problems.push(`bug ligado ${bug} sem cenário de regressão que cite a chave (ou dispense com waivers: [{ item: "${bug}", reason }])`);
  }
  if (coverage.withoutCode) notes.push(`${coverage.withoutCode} critério(s) sem código no card: confira a cobertura à mão`);
  return { problems, notes };
}

/**
 * Exploração mínima ao fechar: charters fechados com resumo (o que cobriu e que testes aplicou).
 * Conta sessão com foco, não número de EXP (3 EXP triviais passavam na regra antiga).
 */
export const MIN_EXPLORATORY: Record<string, number> = { manual: 1, explore: 2 };
