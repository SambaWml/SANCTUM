import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../state/db.ts';
import { planCoverage, type PlanCoverage } from '../state/coverage.ts';
import { checkPlanQuality } from '../state/plan-quality.ts';

/**
 * Análise da US antes do teste (/analisar, 09/11). Medido nos runs: 57 dúvidas de requisito só
 * apareceram testando e 172 de 260 explicações de bug citavam algo que o card não definia. A
 * análise antecipa isso: lacunas por critério, perguntas ao PO, riscos/regressão, melhorias na
 * funcionalidade (sugestão, nunca regra) e um rascunho de cenários no padrão Sanctum, de onde o
 * /qa parte. Nada vai para o Jira daqui.
 */

const text = (max: number) => z.string().min(3).max(max);

export const UsAnalysisInput = z.strictObject({
  issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
  cardVersion: z.string().optional().describe('o "updated" do card lido'),
  summary: text(800).describe('o que a US muda e para quem, em linguagem simples'),
  sources: z.array(text(200)).describe('o que foi lido: card, subtarefas, bugs ligados, comentários, Figma, conhecimento, telas abertas'),
  gaps: z.array(z.strictObject({
    criterion: z.string().max(20).optional().describe('ex.: CA03; vazio se for do card todo'),
    kind: z.enum(['ambiguidade', 'lacuna', 'contradicao', 'testabilidade']),
    text: text(500),
  })),
  questions: z.array(z.strictObject({ text: text(400), options: z.array(z.string().min(1).max(150)).optional(), criterion: z.string().max(20).optional() }))
    .describe('perguntas ao PO, prontas para colar'),
  risks: z.array(z.strictObject({ area: text(120), text: text(400), regressionOf: z.string().max(30).optional().describe('bug antigo que vira regressão') })),
  improvements: z.array(z.strictObject({
    kind: z.enum(['ux', 'consistencia', 'mensagem', 'acessibilidade', 'fluxo-novo', 'desempenho', 'outro']),
    text: text(500),
    why: text(300),
  })).describe('melhorias na funcionalidade: sugestão para o PO, nunca regra nem bug'),
  draftScenarios: z.array(z.strictObject({
    code: z.string().regex(/^CT-\d{3}$/),
    title: text(200), priority: z.enum(['P0', 'P1', 'P2', 'P3']), risk: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    types: z.array(z.string()), preconditions: z.string().optional(), steps: z.array(z.string()).min(1), expected: text(400),
  })).describe('rascunho no padrão Sanctum (ver references/plan-example.md)'),
});
export type UsAnalysisInput = z.infer<typeof UsAnalysisInput>;

export interface UsAnalysisResult {
  id: number; report: { md: string; html: string };
  coverage: PlanCoverage | null;
  /** O que o rascunho ainda não cumpre do padrão (aviso: vira exigência no plan_save do /qa). */
  draftProblems: string[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const GAP_LABEL = { ambiguidade: 'Ambiguidade', lacuna: 'Lacuna', contradicao: 'Contradição', testabilidade: 'Não testável como está' } as const;
const IMP_LABEL = { ux: 'Experiência de uso', consistencia: 'Consistência', mensagem: 'Mensagem/texto', acessibilidade: 'Acessibilidade', 'fluxo-novo': 'Fluxo novo', desempenho: 'Desempenho', outro: 'Outro' } as const;

export function saveUsAnalysis(
  db: Db, rootDir: string, raw: unknown,
  card: { criteria: string[]; linkedBugs: string[] }, agent: string | null, now = new Date(),
): UsAnalysisResult {
  const a = UsAnalysisInput.parse(raw);
  const coverage = card.criteria.length ? planCoverage(card.criteria, a.draftScenarios) : null;
  const draftProblems = a.draftScenarios.length
    ? checkPlanQuality(a.draftScenarios, { mode: 'manual', criteria: card.criteria, linkedBugs: card.linkedBugs, waivers: [] }).problems
    : ['sem rascunho de cenários'];

  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const dir = join(rootDir, 'reports', a.issueKey);
  mkdirSync(dir, { recursive: true });
  const md = join(dir, `analise-${a.issueKey}-${stamp}.md`);
  const html = join(dir, `analise-${a.issueKey}-${stamp}.html`);
  writeFileSync(md, renderMarkdown(a, coverage, draftProblems, now));
  writeFileSync(html, renderHtml(a, coverage, draftProblems, now));

  const r = db.prepare(`INSERT INTO us_analyses (issue_key, card_version, agent, payload, report_path, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(a.issueKey, a.cardVersion ?? null, agent, JSON.stringify(a), `reports/${a.issueKey}/analise-${a.issueKey}-${stamp}.html`, now.toISOString());
  db.prepare(`INSERT INTO events (run_id, scenario_id, type, payload, ts) VALUES (NULL, NULL, 'us.analysis', ?, ?)`)
    .run(JSON.stringify({ issueKey: a.issueKey, gaps: a.gaps.length, questions: a.questions.length, improvements: a.improvements.length, draft: a.draftScenarios.length }), now.toISOString());
  return { id: Number(r.lastInsertRowid), report: { md, html }, coverage, draftProblems };
}

/** Última análise do card, compacta, para o context_build do /qa. */
export function latestUsAnalysis(db: Db, issueKey: string): (UsAnalysisInput & { createdAt: string; report: string | null }) | null {
  const row = db.prepare(`SELECT payload, created_at, report_path FROM us_analyses WHERE issue_key = ? ORDER BY id DESC LIMIT 1`).get(issueKey) as
    { payload: string; created_at: string; report_path: string | null } | undefined;
  return row ? { ...(JSON.parse(row.payload) as UsAnalysisInput), createdAt: row.created_at, report: row.report_path } : null;
}

function renderMarkdown(a: UsAnalysisInput, cov: PlanCoverage | null, problems: string[], now: Date): string {
  const out = [`# Análise da US ${a.issueKey}`, '', `Gerada em ${now.toISOString().slice(0, 16).replace('T', ' ')}. Nada foi publicado no Jira.`, '', a.summary, ''];
  out.push('## Lacunas e ambiguidades', '', ...(a.gaps.length ? a.gaps.map((g) => `- **${GAP_LABEL[g.kind]}${g.criterion ? ` (${g.criterion})` : ''}:** ${g.text}`) : ['- Nenhuma encontrada.']), '');
  out.push('## Perguntas para o PO', '', ...(a.questions.length ? a.questions.map((q, i) => `${i + 1}. ${q.criterion ? `(${q.criterion}) ` : ''}${q.text}${q.options?.length ? `\n   - ${q.options.join('\n   - ')}` : ''}`) : ['- Nenhuma.']), '');
  out.push('## Riscos e impacto', '', ...(a.risks.length ? a.risks.map((r) => `- **${r.area}:** ${r.text}${r.regressionOf ? ` (regressão de ${r.regressionOf})` : ''}`) : ['- Nenhum além do próprio card.']), '');
  out.push('## Melhorias sugeridas na funcionalidade', '', '_Sugestões para o PO avaliar — não são regra nem bug._', '',
    ...(a.improvements.length ? a.improvements.map((m) => `- **${IMP_LABEL[m.kind]}:** ${m.text} — _por quê:_ ${m.why}`) : ['- Nenhuma.']), '');
  out.push('## Rascunho de cenários', '', '| Código | Cenário | P | Risco |', '|---|---|---|---|', ...a.draftScenarios.map((s) => `| ${s.code} | ${s.title} | ${s.priority} | ${s.risk} |`), '');
  if (cov) out.push('### Cobertura dos critérios', '', ...cov.covered.map((c) => `- ✔ ${c}`), ...cov.uncovered.map((c) => `- ⚠️ sem cenário: ${c}`), '');
  if (problems.length) out.push('### Ainda fora do padrão Sanctum', '', ...problems.map((p) => `- ${p}`), '');
  out.push('## Fontes lidas', '', ...a.sources.map((s) => `- ${s}`), '');
  return out.join('\n');
}

function renderHtml(a: UsAnalysisInput, cov: PlanCoverage | null, problems: string[], now: Date): string {
  const li = (items: string[], empty: string) => (items.length ? `<ul>${items.join('')}</ul>` : `<p class="muted">${empty}</p>`);
  const questions = a.questions.map((q) => `<li>${q.criterion ? `<span class="tag">${esc(q.criterion)}</span> ` : ''}${esc(q.text)}${q.options?.length ? `<ul>${q.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}</li>`);
  const copyText = a.questions.map((q, i) => `${i + 1}. ${q.criterion ? `(${q.criterion}) ` : ''}${q.text}${q.options?.length ? ` Opções: ${q.options.join(' / ')}` : ''}`).join('\n');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Análise da US ${esc(a.issueKey)}</title>
<style>
:root{--bg:#f6f7fb;--card:#fff;--fg:#1d2433;--muted:#667085;--line:#e4e7ec;--warn:#b54708;--warnbg:#fffaeb;--ok:#067647;--accent:#3538cd}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b24;--fg:#e6e9ef;--muted:#98a2b3;--line:#2a3140;--warn:#fdb022;--warnbg:#2b2112;--ok:#47cd89;--accent:#8098f9}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--line);margin-right:4px}
.warn{background:var(--warnbg);color:var(--warn);border-color:var(--warn)}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.stats div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}
.stats b{display:block;font-size:22px}
table{width:100%;border-collapse:collapse;background:var(--card)}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
button{font:inherit;border:1px solid var(--accent);color:var(--accent);background:transparent;border-radius:8px;padding:6px 12px;cursor:pointer}
ul{margin:6px 0;padding-left:20px}li{margin:4px 0}
</style></head><body><main>
<h1>Análise da US ${esc(a.issueKey)}</h1>
<p class="muted">Gerada em ${esc(now.toISOString().slice(0, 16).replace('T', ' '))} · nada foi publicado no Jira</p>
<div class="card">${esc(a.summary)}</div>
<div class="stats"><div><b>${a.gaps.length}</b>lacunas</div><div><b>${a.questions.length}</b>perguntas ao PO</div><div><b>${a.risks.length}</b>riscos</div><div><b>${a.improvements.length}</b>melhorias sugeridas</div><div><b>${a.draftScenarios.length}</b>cenários no rascunho</div></div>
<h2>Lacunas e ambiguidades</h2>
${li(a.gaps.map((g) => `<li><span class="tag">${esc(GAP_LABEL[g.kind])}</span>${g.criterion ? `<span class="tag">${esc(g.criterion)}</span>` : ''} ${esc(g.text)}</li>`), 'Nenhuma encontrada.')}
<h2>Perguntas para o PO <button onclick="navigator.clipboard.writeText(document.getElementById('q').textContent).then(()=>this.textContent='✔ copiado')">copiar</button></h2>
${li(questions, 'Nenhuma.')}<pre id="q" hidden>${esc(copyText)}</pre>
<h2>Riscos e impacto</h2>
${li(a.risks.map((r) => `<li><b>${esc(r.area)}:</b> ${esc(r.text)}${r.regressionOf ? ` <span class="tag">regressão de ${esc(r.regressionOf)}</span>` : ''}</li>`), 'Nenhum além do próprio card.')}
<h2>Melhorias sugeridas na funcionalidade</h2>
<p class="muted">Sugestões para o PO avaliar — não são regra nem bug.</p>
${li(a.improvements.map((m) => `<li><span class="tag">${esc(IMP_LABEL[m.kind])}</span> ${esc(m.text)}<br><span class="muted">Por quê: ${esc(m.why)}</span></li>`), 'Nenhuma.')}
<h2>Rascunho de cenários</h2>
${cov && cov.uncovered.length ? `<div class="card warn">⚠️ Critérios sem cenário: ${cov.uncovered.map(esc).join(' · ')}</div>` : cov ? '<div class="card">✔ Todos os critérios com código têm cenário.</div>' : ''}
${problems.length ? `<div class="card warn"><b>Ainda fora do padrão Sanctum</b> (o /qa vai exigir):<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
<table><tr><th>Código</th><th>Cenário</th><th>P</th><th>Risco</th><th>Pré-condição</th><th>Esperado</th></tr>
${a.draftScenarios.map((s) => `<tr><td>${esc(s.code)}</td><td>${esc(s.title)}</td><td>${esc(s.priority)}</td><td>${esc(s.risk)}</td><td>${esc(s.preconditions ?? '—')}</td><td>${esc(s.expected)}</td></tr>`).join('')}</table>
<h2>Fontes lidas</h2>
${li(a.sources.map((s) => `<li>${esc(s)}</li>`), '—')}
</main></body></html>`;
}
