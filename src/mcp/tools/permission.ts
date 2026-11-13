import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { decidePermission } from '../../live/prompts.ts';
import type { Redactor } from '../../security/redact.ts';
import type { Db } from '../../state/db.ts';
import type { StateStore } from '../../state/store.ts';

/**
 * `permission_prompt`: o --permission-prompt-tool do agente lançado pelo painel do Sanctum. Fica fora
 * do registrador comum de propósito: o registrador redige entrada e saída, e o Claude Code precisa
 * receber o input original de volta em updatedInput (redigido, um comando ou arquivo mudaria).
 * O que vai para o painel e para o evento é redigido em decidePermission.
 */
export function registerPermissionPrompt(server: McpServer, deps: { db: Db; redactor: Redactor; store: StateStore }): void {
  server.registerTool(
    'permission_prompt',
    {
      description: 'Uso interno do Claude Code (--permission-prompt-tool) em missões do painel do Sanctum: pede a permissão ao usuário pelo painel. Não chame diretamente.',
      inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
    },
    async (args) => {
      const missionId = process.env.SANCTUM_MISSION || undefined;
      const result = await decidePermission({ db: deps.db, redactor: deps.redactor, missionId }, args.tool_name, args.input);
      deps.store.logEvent(null, null, 'panel.permission', { mission: missionId ?? null, tool: args.tool_name, behavior: result.behavior });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}
