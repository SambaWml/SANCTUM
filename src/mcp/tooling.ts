import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { BrowserError } from '../browser/service.ts';
import { TargetError } from '../browser/target.ts';
import { ConfigError } from '../config/load.ts';
import { ContextError } from '../context/package.ts';
import { KnowledgeError } from '../knowledge/staging.ts';
import { GuardError } from '../guard/guard.ts';
import { DigestError } from '../sources/digest.ts';
import type { Redactor } from '../security/redact.ts';
import { SecretError } from '../security/secrets.ts';
import { StateError, type StateStore } from '../state/store.ts';
import type { Db } from '../state/db.ts';
import { consumeGrant } from '../live/prompts.ts';

export type Shape = Record<string, z.ZodType>;
export type ToolHandler<S extends Shape> = (args: z.infer<z.ZodObject<S>>) => unknown;
export type RegisterTool = <S extends Shape>(name: string, description: string, shape: S, handler: ToolHandler<S>) => void;

/** Resultado com conteúdo MCP próprio (ex.: imagem), em vez de JSON. */
export class ToolContent {
  constructor(readonly content: CallToolResult['content']) {}
}

/** Exigem aprovação humana a cada chamada (plano, ação de risco, escrita no Jira). */
// question_answer: a resposta do usuário vira regra com fonte "manual" — só com a confirmação dele.
const SENSITIVE = new Set(['plan_approve', 'act_approved', 'jira_create_issue', 'jira_comment', 'jira_transition', 'question_answer']);

/** Ferramentas que operam a sessão do navegador (sem runId nos argumentos). */
const SESSION_TOOLS = /^(navigate|act|act_approved|verify|snapshot|screenshot|network|network_simulate|network_simulate_clear|console|browser_viewport|browser_save_auth|browser_close)$/;

const KNOWN_ERRORS = [StateError, SecretError, BrowserError, TargetError, GuardError, DigestError, ContextError, KnowledgeError, ConfigError];

/**
 * Registro comum: entrada e saída sanitizadas, erros de regra devolvidos como mensagem
 * (não exceção) e um evento por chamada (base das métricas).
 */
export function createRegistrar(
  server: McpServer,
  deps: { store: StateStore; redactor: Redactor; db?: Db; requireHumanApproval?: boolean; currentRun?: () => string | null },
): RegisterTool {
  const { store, redactor } = deps;
  return (name, description, shape, handler) => {
    const callback = async (rawArgs: unknown): Promise<CallToolResult> => {
      const args = redactor.value(rawArgs) as Parameters<typeof handler>[0];
      // Quem está operando (metadado do run e das aprovações): clientInfo do MCP + SANCTUM_MODEL.
      const client = server.server.getClientVersion();
      store.agent = {
        ...(client?.name || process.env.SANCTUM_CLIENT ? { client: client?.name ?? process.env.SANCTUM_CLIENT } : {}),
        ...(client?.version ? { version: client.version } : {}),
        ...(process.env.SANCTUM_MODEL ? { model: process.env.SANCTUM_MODEL } : {}),
        ...(process.env.SANCTUM_MISSION ? { mission: process.env.SANCTUM_MISSION } : {}),
      };
      const runId = (args as { runId?: unknown }).runId;
      // Ferramenta de navegador não recebe runId: vale o run da sessão aberta (base de métricas e timeline).
      const scoped = typeof runId === 'string' ? runId : SESSION_TOOLS.test(name) ? deps.currentRun?.() ?? null : null;
      const eventId = store.logEvent(scoped, null, `tool.${name}`, null);
      const started = Date.now();
      try {
        if (deps.requireHumanApproval && SENSITIVE.has(name)) {
          if (!server.server.getClientCapabilities()?.elicitation?.form) {
            throw new GuardError('confirmação humana indisponível: este cliente precisa oferecer MCP elicitation form; ação bloqueada');
          }
          const result = await server.server.elicitInput({
            mode: 'form',
            message: redactor.text(`Sanctum — autorizar ${name}? Confira o plano apresentado ou a ação específica antes de confirmar.\n${JSON.stringify(args)}`),
            requestedSchema: {
              type: 'object',
              properties: { confirm: { type: 'boolean', title: 'Autorizo esta operação específica', default: false } },
              required: ['confirm'],
            },
          });
          if (result.action !== 'accept' || result.content?.confirm !== true) {
            throw new GuardError('operação não autorizada pelo usuário; nenhuma ação executada');
          }
        }
        // Missão do Antigravity lançada pelo painel do Sanctum: plano, ação de risco e escrita no Jira
        // só com a concessão única dada no painel (o modo sem terminal dele não pergunta ao usuário).
        // Sem run (ex.: Jira com o navegador fechado), vale a missão do Antigravity em andamento.
        if (SENSITIVE.has(name) && deps.db && /antigravity/i.test(store.agent?.client ?? '')) {
          const runId = typeof (args as { runId?: unknown }).runId === 'string' ? (args as { runId: string }).runId : deps.currentRun?.() ?? null;
          const mission = (runId ? deps.db.prepare(`SELECT id FROM missions WHERE run_id = ? AND agent = 'antigravity' AND status IN ('RUNNING','WAITING')`).get(runId) : undefined)
            ?? deps.db.prepare(`SELECT id FROM missions WHERE agent = 'antigravity' AND status = 'RUNNING' ORDER BY updated_at DESC LIMIT 1`).get() as { id: string } | undefined;
          if (mission && !consumeGrant(deps.db, (mission as { id: string }).id, name)) {
            throw new GuardError(`${name} sem permissão do usuário no painel da missão ${(mission as { id: string }).id}; peça e encerre o turno`);
          }
        }
        const result = await handler(args);
        store.finishEvent(eventId, { ok: true, ms: Date.now() - started });
        if (result instanceof ToolContent) {
          return { content: result.content.map((c) => (c.type === 'text' ? { ...c, text: redactor.text(c.text) } : c)) };
        }
        return { content: [{ type: 'text', text: JSON.stringify(redactor.value(result)) }] };
      } catch (err) {
        const known = KNOWN_ERRORS.some((E) => err instanceof E);
        const first = ((err as Error).message ?? String(err)).split('\n').slice(0, known ? 12 : 1).join('\n');
        const message = known ? first : `erro: ${first.slice(0, 500)}`;
        // Recusa de regra/guard também é fato do run: fica no evento, redigida e com o motivo inteiro
        // (só a 1ª linha escondia o porquê, ex.: "proposta recusada:" — auditoria de fluxo 09/11).
        store.finishEvent(eventId, { ok: false, ms: Date.now() - started, error: redactor.text(message.replace(/\s*\n\s*/g, ' | ').slice(0, 500)) });
        return { isError: true, content: [{ type: 'text', text: redactor.text(message) }] };
      }
    };
    // O SDK infere o tipo dos args a partir do shape; com o shape genérico essa inferência
    // não fecha, e a validação real (zod) acontece no SDK antes do callback.
    server.registerTool(name, { description, inputSchema: shape }, callback as never);
  };
}
