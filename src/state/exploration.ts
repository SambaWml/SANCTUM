import { latestUsAnalysis } from '../analysis/us-analysis.ts';
import type { Environment } from '../config/schema.ts';
import type { JiraDigest } from '../sources/digest.ts';
import type { Db } from './db.ts';
import type { CharterRow } from './store.ts';

/**
 * Briefing de exploração (auditoria do exploratório 09/11): os testes respeitam o ambiente — sem
 * criação de dados liberada, nada de formulário com valor extremo ou duplo envio — e o foco nasce
 * do que já se sabe (lacunas/riscos da análise da US, bugs ligados), não do zero.
 */

/** Testes que não criam nem alteram dados: valem em qualquer ambiente. */
export const READ_ONLY_TOURS = [
  'estados vazio, carregando e de erro (network_simulate: 500, atraso de 4 s, lista vazia [])',
  'rotas e IDs trocados na URL (outro registro, outro usuário: vaza dado? valida permissão?)',
  'outro papel de usuário na mesma tela',
  'voltar, recarregar e link direto no meio do fluxo',
  'telas vizinhas que mostram o mesmo dado (contadores, listas, relatórios batem?)',
  'celular e tablet (browser_viewport)',
  'console e rede: 4xx/5xx silenciosos com a tela dizendo "sucesso"',
];

/** Testes que criam ou alteram dados: só com allowDataCreation e fora de produção. */
export const DATA_TOURS = [
  'campos no limite (texto longo sem espaço, emoji, aspas, <script>, negativo, zero, número enorme, datas extremas)',
  'duplo clique em salvar e salvar + recarregar (duplicidade, estado corrompido)',
  'pular etapas de formulário em passos e voltar pelo navegador',
];

export const EXPLORATION_RULES = [
  'Siga o charter aberto: alvo, testes e prazo. Saiu do foco? Anote em observations e volte.',
  'EXP (scenario_add) só para comportamento novo que você achou; execute com verify. Área/lote é charter, não EXP.',
  'Usabilidade, layout, texto e melhoria: OBSERVATION (NEEDS_REVIEW ou PASSED), nunca bug.',
  'Bug só se reproduzir (mesma verificação reprovada de novo); visto uma vez → NEEDS_REVIEW "X de Y".',
  'Achado igual a bug já conhecido (knownBugs): cite a chave em vez de criar EXP.',
  'A sessão só fecha com substância: ao menos 10 min explorando (intervalo parado acima de 3 min não conta; não agende espera), 15 ações/navegações, uma evidência (screenshot do que percorreu ou um achado), ao menos 2 testes de tipos diferentes com rastro e rastro de cada teste declarado (disse que simulou erro → chamou network_simulate; disse celular → browser_viewport; disse console/rede → console ou network; outro papel → browser_open com outro papel; IDs/rotas na URL → navigate).',
  'network_simulate funciona dentro da sessão, sem precisar de cenário; a simulação acaba ao iniciar um cenário ou fechar a sessão.',
  'No prazo, charter_end com covered, tours (só o que aplicou de fato), observations e questions. Não deu para continuar (ambiente caiu): shortReason — fica registrada, mas não conta como exploração feita.',
];

export function explorationBrief(db: Db, input: {
  issueKey: string; env: Environment; charters: CharterRow[]; issue?: JiraDigest; now: Date;
}) {
  const { env, charters } = input;
  const canWrite = env.allowDataCreation && env.type !== 'prod';
  const analysis = latestUsAnalysis(db, input.issueKey);
  const knownBugs = (input.issue?.links ?? []).filter((l) => /bug|defeito/i.test(l.relation))
    .map((l) => `${l.key}${l.title ? ` ${l.title}` : ''}${l.status ? ` (${l.status})` : ''}`);
  const open = charters.find((c) => c.status === 'OPEN');
  const leftMin = open?.startedAt ? Math.round(open.timeboxMin - (input.now.getTime() - Date.parse(open.startedAt)) / 60_000) : undefined;
  return {
    charters: charters.filter((c) => c.status === 'PLANNED' || c.status === 'OPEN').map((c) => ({
      code: c.code, status: c.status, target: c.target, tours: c.tours, timeboxMin: c.timeboxMin,
      ...(c.persona ? { persona: c.persona } : {}), ...(c.origin ? { origin: c.origin } : {}),
      ...(c.status === 'OPEN' && leftMin !== undefined ? { minutesLeft: leftMin } : {}),
    })),
    ...(open && leftMin !== undefined && leftMin < 0 ? { overdue: `${open.code} passou ${-leftMin} min do prazo: feche com charter_end (o que ficou de fora vai em notes)` } : {}),
    tours: {
      allowed: canWrite ? [...READ_ONLY_TOURS, ...DATA_TOURS] : READ_ONLY_TOURS,
      ...(canWrite ? {} : { notAllowed: `${DATA_TOURS.join('; ')} — ${env.type === 'prod' ? 'ambiente de produção' : 'criação de dados não liberada neste ambiente'}` }),
    },
    ...(env.notes ? { environmentNotes: env.notes } : {}),
    ...(analysis ? {
      seeds: {
        from: `análise da US de ${analysis.createdAt.slice(0, 10)}`,
        gaps: analysis.gaps.slice(0, 8).map((g) => `${g.criterion ? `${g.criterion} ` : ''}[${g.kind}] ${g.text}`),
        risks: analysis.risks.slice(0, 6).map((r) => `${r.area}: ${r.text}${r.regressionOf ? ` (regressão de ${r.regressionOf})` : ''}`),
      },
    } : {}),
    ...(knownBugs.length ? { knownBugs } : {}),
    rules: EXPLORATION_RULES,
  };
}

/**
 * Substância mínima de uma sessão (auditoria 12/11): a primeira missão real fechou 3 sessões de
 * 45 min em 4, 3 e 2 min, sem evidência, e declarou testes que não tinham rastro. Fechar sessão
 * não basta: precisa de tempo, atividade, uma evidência e rastro do que diz ter aplicado.
 */
export const CHARTER_MIN: CharterMin = { minutes: 10, activity: 15, provenTours: 2, idleCapMin: 3 };
export interface CharterMin {
  minutes: number; activity: number;
  /** Testes declarados com rastro na sessão (13/11: sessões só olhavam a tela e esperavam o tempo passar). */
  provenTours?: number;
  /** Intervalo máximo entre duas atividades que conta como exploração; o resto é espera. */
  idleCapMin?: number;
}

/** Minutos com atividade: soma os intervalos entre atividades, cada um limitado a idleCapMin. */
export function activeMinutes(since: string, activityTs: string[], idleCapMin = CHARTER_MIN.idleCapMin!): number {
  const cap = idleCapMin * 60_000;
  let prev = Date.parse(since);
  let total = 0;
  for (const t of activityTs.map((x) => Date.parse(x)).filter((x) => x >= prev).sort((a, b) => a - b)) {
    total += Math.min(t - prev, cap);
    prev = t;
  }
  return Math.round(total / 60_000);
}

export interface CharterFacts {
  minutes: number; actions: number; navigations: number; screenshots: number; findings: number;
  simulations: number; viewports: number; inspections: number; roleOpens: number;
}

/** Teste declarado → o que precisa ter acontecido na sessão para ele ser verdade. */
const TOUR_TRACE: { re: RegExp; ok: (f: CharterFacts) => boolean; need: string }[] = [
  { re: /network_simulate|simul|erro 500|falha d[ae] (api|rede)|api (fora|em erro)|offline/i, ok: (f) => f.simulations > 0, need: 'network_simulate' },
  { re: /celular|mobile|tablet|responsiv|viewport/i, ok: (f) => f.viewports > 0, need: 'browser_viewport' },
  { re: /console|\b[45]xx\b|erros? de rede|requisi[çc][õo]es? falh/i, ok: (f) => f.inspections > 0, need: 'console ou network' },
  { re: /outro (papel|perfil|usu[áa]rio)|troca de (papel|perfil)/i, ok: (f) => f.roleOpens > 1, need: 'browser_open com outro papel' },
  { re: /\bids?\b.*url|url.*\bids?\b|rotas? diret|link direto/i, ok: (f) => f.navigations > 1, need: 'navigate (mais de uma rota)' },
];

export function checkCharterSubstance(tours: string[], facts: CharterFacts, min: CharterMin = CHARTER_MIN): string[] {
  const problems: string[] = [];
  if (facts.minutes < min.minutes) problems.push(`${facts.minutes} min de exploração (mínimo ${min.minutes}): conta o tempo com ações, verificações e prints — esperar parado não soma`);
  const activity = facts.actions + facts.navigations;
  if (activity < min.activity) problems.push(`${activity} ações/navegações (mínimo ${min.activity})`);
  if (facts.screenshots + facts.findings === 0) problems.push('nenhuma evidência: tire ao menos um screenshot do que percorreu ou registre um achado (scenario_add)');
  const proven = new Set<string>();
  for (const tour of tours) {
    const matches = TOUR_TRACE.filter((t) => t.re.test(tour));
    const miss = matches.find((t) => !t.ok(facts));
    if (miss) problems.push(`"${tour.slice(0, 70)}" foi declarado, mas não houve ${miss.need} na sessão: aplique o teste ou tire da lista`);
    else for (const t of matches) proven.add(t.need);
  }
  const needProven = min.provenTours ?? 0;
  if (proven.size < needProven) {
    const missing = TOUR_TRACE.filter((t) => !proven.has(t.need)).map((t) => t.need);
    problems.push(`${proven.size} teste(s) com rastro na sessão (mínimo ${needProven} de tipos diferentes): olhar a tela e mapear não é explorar — ` +
      `aplique e declare em tours testes como estado de erro/lentidão (network_simulate), celular (browser_viewport), console/rede, outro papel ou IDs trocados na URL (falta: ${missing.join(', ')})`);
  }
  return problems;
}
