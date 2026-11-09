import { z } from 'zod';
import { getTwgBin, runTwgJson } from '../../sources/jira.ts';
import { StateError } from '../../state/store.ts';
import { buildBugPack } from '../../evidence/bug-pack.ts';
import type { Db } from '../../state/db.ts';
import type { RegisterTool } from '../tooling.ts';

/**
 * Escrita no Jira pelo Sanctum (criar card/sub-bug, comentar, mudar status), pela CLI `twg` já
 * autenticada na conta do usuário — funciona com qualquer agente, inclusive o Antigravity, que não
 * completa o login do Atlassian MCP fora do editor. As três são sensíveis: o usuário aprova cada
 * chamada (Claude Code: "ask"; painel: pedido no "Precisa de você"; Codex: approval prompt).
 */

export const JIRA_WRITE_TOOLS = ['jira_create_issue', 'jira_comment', 'jira_transition'] as const;

/** Card de bug/evidência não cita a ferramenta de automação nem anexa trace (regra do usuário). */
function checkText(...texts: (string | undefined)[]): void {
  for (const t of texts) {
    if (t && /playwright|trace\.zip|\.trace\b/i.test(t)) throw new StateError('texto para o Jira não pode citar Playwright nem trace: descreva o comportamento do sistema');
  }
}

/** Executa a twg e devolve o JSON da resposta (envelope com arquivo ou JSON direto, ver runTwgJson). */
function twg(args: string[]): unknown {
  if (!getTwgBin()) throw new StateError('CLI twg do Atlassian não encontrada (TWG_BIN ou %LOCALAPPDATA%\\Programs\\twg\\bin\\twg.exe)');
  try {
    return runTwgJson(args);
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new StateError(`twg falhou: ${(e.stderr || e.stdout || e.message).trim().split('\n').slice(0, 6).join(' ').slice(0, 600)}`);
  }
}

const first = (v: unknown): Record<string, unknown> => {
  const data = (v as { data?: unknown })?.data;
  return (Array.isArray(data) ? data[0] : data) as Record<string, unknown> ?? {};
};

export function registerJiraTools(tool: RegisterTool, deps: { db: Db; rootDir: string }): void {
  tool(
    'jira_create_issue',
    'Cria card no Jira (ex.: Sub-bug com parent). Só com pedido explícito do usuário; o usuário aprova cada chamada. ' +
      'Descrição em markdown: como reproduzir, o que acontece, o esperado (critério do card). Nunca cite Playwright nem anexe trace.',
    {
      project: z.string().regex(/^[A-Z][A-Z0-9]+$/).describe('chave do projeto, ex.: PROJ'),
      type: z.string().min(2).describe('tipo, ex.: "Sub-bug", "Bug", "Task"'),
      summary: z.string().min(5).max(255),
      description: z.string().min(10).max(20_000),
      parent: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).optional(),
      labels: z.array(z.string().min(1)).optional(),
    },
    (a) => {
      checkText(a.summary, a.description);
      const raw = twg(['jira', 'workitem', 'create', '--space', a.project, '--type', a.type, '--summary', a.summary,
        '--description', a.description, '--description-format', 'markdown',
        ...(a.parent ? ['--parent', a.parent] : []), ...(a.labels?.length ? ['--labels', a.labels.join(',')] : []), '-y']);
      const res = first(raw);
      const key = res.key ?? res.id ?? null;
      // Formato inesperado: devolve a resposta para o agente não achar que falhou e criar de novo.
      return { created: key, url: res.url ?? null, summary: a.summary, ...(key ? {} : { raw: JSON.stringify(raw).slice(0, 800) }) };
    },
  );

  tool(
    'bug_evidence',
    'Monta a pasta de evidência de um bug já criado no Jira (obrigatório logo após jira_create_issue): ' +
      'runs/_evidencias/<card>-sub-bugs/<BUG> <título>/ com prints dos cenários, quadros do vídeo no momento do defeito, ' +
      'trecho de vídeo de cada cenário, respostas de API e LEIA-ME; nunca trace. frames: momento exato em que o defeito ' +
      'aparece (offsetSec a partir do início do cenário no vídeo) com nome que diga o que mostra, ex.: "aba Aprofundamentos 0 com 1 linha".',
    {
      runId: z.string(),
      issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).describe('o bug criado, ex.: PROJ-456'),
      title: z.string().min(3).max(120).describe('título curto da pasta'),
      codes: z.array(z.string()).min(1).describe('cenários que mostram o bug'),
      frames: z.array(z.object({ code: z.string(), offsetSec: z.number().min(0), name: z.string().min(3) })).optional(),
    },
    (a) => buildBugPack(deps.db, deps.rootDir, a),
  );

  tool(
    'jira_comment',
    'Comenta num card do Jira. Só com pedido explícito do usuário; o usuário aprova cada chamada. Só o que foi testado, sem menções salvo pedido.',
    { issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/), body: z.string().min(5).max(20_000) },
    (a) => {
      checkText(a.body);
      const res = first(twg(['jira', 'workitem', 'comment', 'create', '--issue-id', a.issueKey, '--body', a.body, '--body-format', 'markdown']));
      return { commented: a.issueKey, id: res.id ?? null };
    },
  );

  tool(
    'jira_transition',
    'Muda o status de um card do Jira (nome do status ou id da transição). Só com pedido explícito do usuário; o usuário aprova cada chamada.',
    { issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/), transition: z.string().min(1).describe('ex.: "Done", "FIX IT" ou o id da transição') },
    (a) => {
      twg(['jira', 'workitem', 'transition', '--id', a.issueKey, '--transition-id', a.transition]);
      return { transitioned: a.issueKey, to: a.transition };
    },
  );
}
