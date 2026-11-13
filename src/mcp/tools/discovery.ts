import { z } from 'zod';
import { addUserRule } from '../../knowledge/staging.ts';
import { deriveMapFromExecution, loadSystemMap, mapIndex, saveSystemMap, SystemMapInput } from '../../knowledge/system-map.ts';
import { StateError, type StateStore } from '../../state/store.ts';
import type { RegisterTool } from '../tooling.ts';

/**
 * Modo descoberta (12/11): chegar num sistema sem saber nada. Mapear só olhando (system_map_save),
 * perguntar o que não dá para deduzir (question_ask) e só então planejar. A resposta do usuário
 * (question_answer, confirmada por ele a cada chamada) vira regra com fonte.
 */
export function registerDiscoveryTools(tool: RegisterTool, deps: { store: StateStore; rootDir: string }): void {
  const { store, rootDir } = deps;
  const module = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('módulo de conhecimento (ex.: agenda, pacientes)');

  tool(
    'system_map_save',
    'Grava o mapa do sistema testado (knowledge/<projeto>/mapa.yaml): telas (rota, nome, o que mostra, ações com risco, APIs, acesso por papel), ' +
      'entidades e o que foi visto mas não visitado (unvisited). Só acrescenta: tela nova entra, tela conhecida ganha o que você viu agora. ' +
      'Descreva só o que VIU — o mapa não é regra de negócio. fromExecution: true gera a primeira versão a partir das rotas e ações já validadas ' +
      'em testes anteriores (marcadas "deduzida"). Em missão exploratória o plano só é aceito com o mapa do projeto.',
    {
      runId: z.string(),
      fromExecution: z.boolean().optional().describe('projeto já testado e sem mapa: parte do que os testes anteriores validaram'),
      screens: SystemMapInput.shape.screens.optional(),
      entities: SystemMapInput.shape.entities,
      unvisited: SystemMapInput.shape.unvisited,
    },
    (a) => {
      const run = store.getRun(a.runId);
      const derived = a.fromExecution ? deriveMapFromExecution(rootDir, run.project) : null;
      if (a.fromExecution && !derived && !a.screens?.length) throw new StateError(`não há execuções anteriores de ${run.project} para deduzir o mapa: mapeie navegando`);
      if (derived) saveSystemMap(rootDir, run.project, derived);
      if (!a.screens?.length && !derived) throw new StateError('informe screens (as telas que você abriu) ou fromExecution: true');
      const saved = a.screens?.length
        ? saveSystemMap(rootDir, run.project, { screens: a.screens, entities: a.entities, unvisited: a.unvisited })
        : { map: loadSystemMap(rootDir, run.project)!, added: derived!.screens.map((s) => s.route), updated: [], file: `knowledge/${run.project}/mapa.yaml` };
      store.logEvent(run.id, null, 'map.save', { screens: saved.map.screens.length, added: saved.added.length, updated: saved.updated.length });
      return { file: saved.file, screens: saved.map.screens.length, added: saved.added, updated: saved.updated, index: mapIndex(saved.map) };
    },
  );

  tool(
    'question_ask',
    'Registra perguntas para o usuário sobre o que NÃO dá para deduzir olhando o sistema (regra, limite, o que é o certo). Curtas, com opções quando houver. ' +
      'Depois mostre as perguntas ao usuário e espere: em missão exploratória o plano não é aceito com pergunta em aberto. ' +
      'Não pergunte o que o card, o conhecimento do projeto ou a própria tela já respondem.',
    {
      runId: z.string(),
      questions: z.array(z.strictObject({
        module,
        text: z.string().min(8).max(300),
        options: z.array(z.string().min(1).max(120)).max(5).optional(),
        about: z.string().max(200).optional().describe('tela ou hipótese que motivou a pergunta'),
      })).min(1).max(10),
    },
    (a) => {
      const all = store.askQuestions(a.runId, a.questions);
      const open = all.filter((q) => q.status === 'OPEN');
      return {
        open: open.map((q) => ({ id: q.id, text: q.text, ...(q.options.length ? { options: q.options } : {}), ...(q.about ? { about: q.about } : {}) })),
        next: 'Mostre as perguntas ao usuário, numeradas, e espere a resposta. Cada resposta entra com question_answer (o usuário confirma). Não responda por ele.',
      };
    },
  );

  tool(
    'question_answer',
    'Registra a resposta que o USUÁRIO deu a uma pergunta (answer, nas palavras dele) ou a dispensa (dismiss, com o motivo — ex.: "usuário não sabe; perguntar ao PO"). ' +
      'A resposta vira regra de negócio com fonte "usuário" no conhecimento do projeto (rule: a regra em uma frase afirmativa). ' +
      'O usuário confirma cada chamada: nunca registre resposta que ele não deu.',
    {
      runId: z.string(),
      id: z.number().int().positive(),
      answer: z.string().min(1).max(500).optional(),
      rule: z.string().min(8).max(300).optional().describe('com answer: a regra em uma frase (ex.: "Consulta confirmada pode ser cancelada pela recepção")'),
      dismiss: z.string().min(5).max(300).optional(),
    },
    (a) => {
      if (!a.answer === !a.dismiss) throw new StateError('informe answer (com rule) ou dismiss, um dos dois');
      if (a.answer && !a.rule) throw new StateError('com answer, informe rule: a regra em uma frase afirmativa, como o usuário respondeu');
      const run = store.getRun(a.runId);
      const q = store.answerQuestion(a.runId, a.id, { answer: a.answer, dismiss: a.dismiss });
      const day = (q.answeredAt ?? new Date().toISOString()).slice(0, 10);
      const saved = a.answer ? addUserRule(rootDir, run.project, q.module, a.rule!, `usuário, ${day} (pergunta do run ${run.id}: ${q.text.slice(0, 120)})`) : null;
      const open = store.listQuestions(a.runId).filter((x) => x.status === 'OPEN').length;
      return { id: q.id, status: q.status, ...(saved ? { rule: a.rule, file: saved.file } : {}), stillOpen: open };
    },
  );
}
