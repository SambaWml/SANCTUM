import type { Redactor } from '../security/redact.ts';
import type { Db } from '../state/db.ts';
import { isForbiddenRule } from './agents.ts';

/**
 * Pedidos que esperam o usuário no painel ao vivo. O agente lançado pelo painel roda sem terminal:
 * quando o Claude Code precisa de permissão para uma ferramenta, chama a ferramenta MCP
 * `permission_prompt`, que grava o pedido aqui e espera a resposta dada pelo botão do painel.
 * A aprovação do plano clicada no painel fica gravada antes (kind 'plan') e libera o plan_approve
 * seguinte sem pedir de novo.
 */

export type Decision = 'allow' | 'deny';
export interface PromptRow {
  id: number; mission_id: string; kind: 'permission' | 'plan'; tool: string | null; summary: string; input_json: string | null;
  status: 'PENDING' | 'ANSWERED' | 'USED' | 'EXPIRED'; decision: Decision | null; message: string | null; created_at: string; answered_at: string | null;
}
export type PermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

const short = (v: unknown, n = 300) => {
  const s = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v) ?? '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Uma linha legível do que o agente quer fazer (o detalhe completo, redigido, vai em input_json). */
export function describeTool(tool: string, input: Record<string, unknown>): string {
  const name = tool.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '');
  switch (name) {
    case 'plan_approve': return `Aprovar o plano do run ${short(input.runId, 80)}`;
    case 'act_approved': {
      const target = input.target as Record<string, unknown> | undefined;
      const what = target ? short(target.name ?? target.label ?? target.text ?? target.testId ?? JSON.stringify(target), 120) : '';
      return `Ação de risco: ${short(input.action, 30)} em "${what}" — ${short(input.justification, 200)}`;
    }
    case 'jira_create_issue': return `Criar ${short(input.type, 30)} no Jira${input.parent ? ` em ${short(input.parent, 30)}` : ''}: "${short(input.summary, 200)}"`;
    case 'jira_comment': return `Comentar no ${short(input.issueKey, 30)}: ${short(input.body, 250)}`;
    case 'jira_transition': return `Mudar o status do ${short(input.issueKey, 30)} para "${short(input.transition, 60)}"`;
    case 'Bash': case 'PowerShell': return `Rodar comando: ${short(input.command, 400)}`;
    case 'Write': case 'Edit': case 'NotebookEdit': return `${name === 'Write' ? 'Criar/sobrescrever' : 'Editar'} arquivo ${short(input.file_path, 200)}`;
    default: return `Usar ${name}: ${short(input, 300)}`;
  }
}

export function createPrompt(db: Db, p: { missionId: string; kind: 'permission' | 'plan'; tool?: string; summary: string; input?: unknown; decision?: Decision }, now = new Date()): number {
  const ts = now.toISOString();
  const answered = p.decision !== undefined;
  const r = db.prepare(`INSERT INTO prompts (mission_id, kind, tool, summary, input_json, status, decision, created_at, answered_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.missionId, p.kind, p.tool ?? null, p.summary, p.input === undefined ? null : JSON.stringify(p.input),
      answered ? 'ANSWERED' : 'PENDING', p.decision ?? null, ts, answered ? ts : null);
  return Number(r.lastInsertRowid);
}

export function answerPrompt(db: Db, id: number, decision: Decision, message: string | undefined, now = new Date()): boolean {
  const r = db.prepare(`UPDATE prompts SET status = 'ANSWERED', decision = ?, message = ?, answered_at = ? WHERE id = ? AND status = 'PENDING'`)
    .run(decision, message ?? null, now.toISOString(), id);
  return Number(r.changes) === 1;
}

export function pendingPrompts(db: Db): PromptRow[] {
  return db.prepare(`SELECT * FROM prompts WHERE status = 'PENDING' ORDER BY id`).all() as unknown as PromptRow[];
}

/**
 * Concessão dada no painel e ainda não usada: consome e libera uma chamada. O botão "Aprovar plano"
 * grava sem ferramenta (vale para plan_approve); a permissão do Antigravity grava a ferramenta.
 */
export function consumeGrant(db: Db, missionId: string, tool: string): boolean {
  const row = db.prepare(`SELECT id FROM prompts WHERE mission_id = ? AND kind = 'plan' AND status = 'ANSWERED' AND decision = 'allow'
                          AND (tool = ? OR (tool IS NULL AND ? = 'plan_approve')) ORDER BY id LIMIT 1`)
    .get(missionId, tool, tool) as { id: number } | undefined;
  if (!row) return false;
  db.prepare(`UPDATE prompts SET status = 'USED' WHERE id = ?`).run(row.id);
  return true;
}

export interface PermissionDeps {
  db: Db; redactor: Redactor; missionId: string | undefined;
  timeoutMs?: number; pollMs?: number; now?: () => Date; sleep?: (ms: number) => Promise<void>;
}

/** Resposta ao --permission-prompt-tool do Claude Code: espera a decisão do usuário no painel. */
export async function decidePermission(deps: PermissionDeps, toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
  const { db, redactor, missionId } = deps;
  const now = deps.now ?? (() => new Date());
  if (!missionId) return { behavior: 'deny', message: 'permissão pelo painel só vale para missões lançadas pelo painel do Sanctum' };
  // Proibido sempre, sem perguntar: terminal e escrita nos arquivos do próprio Sanctum.
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
  if (isForbiddenRule(toolName, file)) {
    return { behavior: 'deny', message: 'proibido em missão do painel: terminal e alteração dos arquivos do Sanctum. Use as ferramentas do sanctum; o relatório abre pelo painel.' };
  }
  if (/plan_approve$/.test(toolName) && consumeGrant(db, missionId, 'plan_approve')) return { behavior: 'allow', updatedInput: input };

  // O pedido mostrado no painel é redigido; o input original só volta para o Claude Code.
  const id = createPrompt(db, {
    missionId, kind: 'permission', tool: toolName,
    summary: redactor.text(describeTool(toolName, input)), input: redactor.value(input),
  }, now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now().getTime() + (deps.timeoutMs ?? 30 * 60_000);
  while (now().getTime() < deadline) {
    const row = db.prepare('SELECT status, decision, message FROM prompts WHERE id = ?').get(id) as Pick<PromptRow, 'status' | 'decision' | 'message'>;
    if (row.status === 'ANSWERED') {
      db.prepare(`UPDATE prompts SET status = 'USED' WHERE id = ?`).run(id);
      return row.decision === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `o usuário negou pelo painel${row.message ? `: ${row.message}` : ''}` };
    }
    await sleep(deps.pollMs ?? 1000);
  }
  db.prepare(`UPDATE prompts SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'`).run(id);
  return { behavior: 'deny', message: 'sem resposta do usuário no painel a tempo; ação não executada' };
}
