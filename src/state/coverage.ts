/**
 * Cobertura dos critérios de aceite pelo plano (auditoria de fluxo 09/11: planos de 20 cenários
 * aprovados em 1 minuto). Cada critério com código (CA03, AC-3, CA 3) é ligado aos cenários que
 * citam o mesmo número no título ou no esperado; critério sem código é apontado para conferência.
 */

export interface PlanCoverage {
  covered: string[];
  /** Critérios sem nenhum cenário: o que o usuário precisa ver antes de aprovar. */
  uncovered: string[];
  /** Critérios sem código no card: não dá para ligar automaticamente. */
  withoutCode: number;
}

const CODE = /\b(?:CA|AC)[\s.-]*0*(\d{1,3})\b/i;

export function planCoverage(criteria: string[], scenarios: { code: string; title: string; expected?: string | null }[]): PlanCoverage {
  const covered: string[] = [];
  const uncovered: string[] = [];
  let withoutCode = 0;
  const cites = (n: number, text: string) => new RegExp(`\\b(?:CA|AC)[\\s.-]*0*${n}\\b`, 'i').test(text);
  for (const c of criteria) {
    const m = CODE.exec(c);
    if (!m) { withoutCode++; continue; }
    const n = Number(m[1]);
    const label = `CA${String(n).padStart(2, '0')}`;
    const hits = scenarios.filter((s) => cites(n, `${s.title} ${s.expected ?? ''}`)).map((s) => s.code);
    if (hits.length) covered.push(`${label} → ${hits.join(', ')}`);
    else uncovered.push(`${label}: ${c.replace(CODE, '').replace(/^[\s:.–—-]+/, '').slice(0, 140)}`);
  }
  return { covered, uncovered, withoutCode };
}
