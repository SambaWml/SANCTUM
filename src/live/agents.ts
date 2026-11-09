import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Como cada agente roda uma missão em segundo plano (um processo por turno) e como a saída dele é
 * lida. O resto (estado da missão, painel, pedidos) é comum, em missions.ts.
 *
 * - Claude Code (`claude -p`, stream-json): permissão pedida durante o turno pelo
 *   --permission-prompt-tool, que espera o clique no painel.
 * - Antigravity (`agy -p`, stream-json): o modo sem terminal não pergunta; o que não está liberado
 *   é negado na hora e o turno termina dizendo a regra exata. O painel mostra o pedido e, permitido,
 *   continua a conversa com aquela regra liberada só para o turno seguinte.
 */

export type MissionAgent = 'claude' | 'antigravity';
export type MissionKind = 'qa' | 'explore' | 'retest' | 'resume' | 'analyze';
export type MissionTarget = { kind: 'card'; key: string } | { kind: 'url'; url: string };
export type Windows = Record<string, { utilization?: number; resetsAt?: number }>;

/** O que interessa de uma linha da saída do agente. */
export interface TurnEvent {
  session?: string;
  activity?: string;
  text?: string;
  /** Ação negada por falta de permissão (Antigravity): a regra exata, como o agente a pediu. */
  denied?: { rule: string; detail: string };
  result?: { text: string; error: boolean };
  limits?: Windows;
  ts?: string;
}

export interface AgentDriver {
  label: string;
  bin(): string;
  firstPrompt(target: MissionTarget, kind: MissionKind, objective?: string): string;
  args(input: { prompt: string; resume?: string; allow: string[] }): string[];
  parse(line: unknown): TurnEvent[];
}

/** Ferramentas do sanctum que o agente usa sem pedir. plan_approve e act_approved nunca: passam pelo painel. */
export const SANCTUM_TOOLS = ['run_start', 'run_status', 'run_complete', 'plan_save', 'plan_view', 'batch_brief', 'scenario_start', 'scenario_complete',
  'scenario_add', 'scenario_reopen', 'scenario_reclassify', 'retest_seed', 'context_build', 'digest_get', 'digest_put', 'getJiraIssue', 'data_register', 'cleanup_run',
  'knowledge_propose', 'report_build', 'config_reload', 'metrics_run', 'browser_open', 'browser_close', 'browser_save_auth', 'browser_viewport',
  'navigate', 'snapshot', 'act', 'verify', 'network', 'network_simulate', 'network_simulate_clear', 'console', 'screenshot',
  'automation_assess', 'automation_spec', 'automation_run',
  // Pasta de evidência local e cadastro que só acrescenta: sem pedido (auditoria de fluxo 09/11).
  'bug_evidence', 'env_register',
  // Análise da US: só grava no estado local e gera relatório.
  'us_analysis_save'];

/** Atlassian: leitura liberada; escrita no Jira passa pelas ferramentas jira_* do sanctum, com aprovação. */
export const ATLASSIAN_READ = ['getJiraIssue', 'searchJiraIssuesUsingJql', 'getConfluencePage', 'getAccessibleAtlassianResources'];

export const ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Skill', 'Agent', 'Task', 'TodoWrite',
  ...SANCTUM_TOOLS.map((t) => `mcp__sanctum__${t}`),
  ...ATLASSIAN_READ.map((t) => `mcp__atlassian__${t}`),
];

/**
 * Antigravity: o que nunca é liberado, nem pelo painel — operar o sistema por fora do Action Guard
 * (comando no terminal, navegador próprio do agente). O agente usa o navegador do sanctum.
 */
export const AGY_FORBIDDEN = ['run_command', 'send_command_input', 'open_browser_url', 'browser_subagent', 'execute_browser_javascript',
  'click_browser_pixel', 'browser_click_element', 'browser_input', 'browser_press_key', 'browser_select_option', 'browser_drag_pixel_to_pixel',
  'browser_mouse_down', 'browser_mouse_up', 'browser_move_mouse', 'browser_scroll', 'browser_scroll_dom', 'browser_refresh_page',
  'browser_resize_window', 'read_browser_page', 'browser_get_dom', 'capture_browser_screenshot', 'capture_browser_console_logs'];

/** Ferramentas de escrita de arquivo (Antigravity e Claude Code). */
const FILE_WRITE = /^(write_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit|Write|Edit|NotebookEdit)$/;

/**
 * Arquivos do próprio Sanctum: missão testa sistemas, não altera a ferramenta (código, regras,
 * agentes, política). Cadastro de ambiente/projeto em config/ continua possível, com permissão.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..').replace(/\\/g, '/').toLowerCase().replace(/\/?$/, '/');

export function isProtectedPath(path: string, root = REPO_ROOT): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase();
  const base = root.replace(/\\/g, '/').toLowerCase().replace(/\/?$/, '/');
  // Absoluto dentro da pasta do projeto (qualquer nome: "NEW QA", "SANCTUM"…) → relativo; fora dela não é da ferramenta.
  if (/^([a-z]:)?\//.test(p) && !p.startsWith(base)) return false;
  const rel = p.startsWith(base) ? p.slice(base.length) : p.replace(/^\.\//, '');
  return /^(src|test|\.claude|\.codex|\.agents|node_modules)\//.test(rel)
    || /^(\.mcp\.json|agents\.md|claude\.md|package(-lock)?\.json|tsconfig\.json|vitest\.config\.ts|config\/qa-policy\.yaml)$/.test(rel);
}

/**
 * Regra que nunca é liberada, nem pelo painel: terminal e navegador próprio do agente (por fora
 * do Action Guard) e escrita nos arquivos do Sanctum. Aceita a regra do Antigravity
 * ("write_file(C:/…/src/x.ts)", "shell") ou nome de ferramenta + caminho (Claude Code).
 */
export function isForbiddenRule(rule: string, path?: string): boolean {
  const name = rule.replace(/\(.*$/s, '').trim();
  // "shell"/"command": como o painel registra a negação de run_command vinda do resultado do turno.
  if (AGY_FORBIDDEN.includes(name) || /^(shell|command|Bash|PowerShell)$/.test(name)) return true;
  if (FILE_WRITE.test(name)) {
    const target = path ?? /\((.*)\)$/s.exec(rule)?.[1] ?? '';
    return isProtectedPath(target);
  }
  return false;
}

const PANEL_RULES =
  'Você foi lançado pela Central de Caça (painel do Sanctum) e roda sem terminal. Siga o roteiro da skill etapa por etapa, só com as ferramentas do Sanctum. ' +
  'Quando precisar do usuário (aprovar o plano, escolher usuário, tirar dúvida), escreva a pergunta no fim da sua resposta e encerre o turno: a resposta chega na próxima mensagem. ' +
  'Não use ferramenta de pergunta ao usuário. Permissões são pedidas ao usuário pelo painel. Senha nunca: só usuários já cadastrados ou .env.';

export function missionCommand(target: MissionTarget, kind: MissionKind, objective?: string): string {
  const cmd = target.kind === 'url' ? `/qa ${target.url} --explore`
    : { qa: `/qa ${target.key}`, explore: `/qa ${target.key} --explore`, retest: `/retest ${target.key}`, resume: `/qa-resume ${target.key}`, analyze: `/analisar ${target.key}` }[kind];
  return objective ? `${cmd} ${objective}` : cmd;
}

/** Roteiro para agente sem as skills como comando: amarra cada etapa às ferramentas do Sanctum. */
export function boundPrompt(target: MissionTarget, kind: MissionKind, objective?: string): string {
  if (kind === 'analyze' && target.kind === 'card') {
    return [
      'Atue como QA usando o Sanctum neste workspace, seguindo a ferramenta à risca:',
      '1. Leia AGENTS.md e CLAUDE.md antes de qualquer ação.',
      '2. Siga o roteiro .claude/skills/analisar/SKILL.md etapa por etapa, na ordem.',
      '3. Leia o Jira pelo sanctum (getJiraIssue, digest_get/digest_put) e grave a análise com us_analysis_save. Não use terminal, scripts nem o seu navegador próprio; telas do sistema só pelo navegador do sanctum, sem alterar dados.',
      '4. Nada vai para o Jira: perguntas e melhorias ficam no relatório para eu decidir.',
      PANEL_RULES,
      '',
      `Missão: ${missionCommand(target, kind)}${objective ? `\nObjetivo/observação: ${objective}` : ''}`,
    ].join('\n');
  }
  const skill = target.kind === 'url' ? 'qa' : { qa: 'qa', explore: 'qa', retest: 'retest', resume: 'qa-resume', analyze: 'qa' }[kind];
  return [
    'Atue como QA usando o Sanctum neste workspace, seguindo a ferramenta à risca:',
    '1. Leia AGENTS.md e CLAUDE.md antes de qualquer ação.',
    `2. Siga o roteiro .claude/skills/${skill}/SKILL.md etapa por etapa, na ordem, lendo as referências de cada etapa. Onde o roteiro fala do Claude (subagente, confirmação), use as adaptações de docs/CODEX.md e execute os lotes você mesmo.`,
    '3. Opere o sistema só pelas ferramentas do MCP sanctum (call_mcp_tool, servidor sanctum). O sanctum integra digest_get e getJiraIssue para leitura direta do Jira sem depender de MCP externo. Não use comandos de terminal, scripts, nem o seu navegador próprio: o navegador é o do sanctum (browser_open, navigate, act, verify).',
    '4. Mostre o plano e espere minha aprovação antes de plan_approve. Ação de risco (RED) só com minha autorização para aquela ação.',
    '5. Nunca declare PASSED sem verificação registrada (verify). Senha só pelo .env (secret:NOME).',
    '6. Feche com limpeza, run_complete e report_build. Card de bug no Jira só se eu pedir.',
    PANEL_RULES,
    '',
    `Missão: ${missionCommand(target, kind)}${objective ? `\nObjetivo/observação: ${objective}` : ''}`,
  ].join('\n');
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export const claudeDriver = (bin?: string): AgentDriver => ({
  label: 'Claude Code',
  bin: () => bin ?? 'claude',
  firstPrompt: missionCommand,
  args: ({ prompt, resume }) => ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'mcp__sanctum__permission_prompt',
    '--allowedTools', ALLOWED_TOOLS.join(','),
    '--disallowedTools', 'AskUserQuestion',
    '--append-system-prompt', PANEL_RULES,
    ...(resume ? ['--resume', resume] : [])],
  parse(line) {
    const ev = obj(line);
    const out: TurnEvent[] = [];
    const ts = str(ev.timestamp) || undefined;
    if (str(ev.session_id)) out.push({ session: str(ev.session_id) });
    if (ev.type === 'assistant') {
      for (const b of (obj(ev.message).content as Obj[] | undefined) ?? []) {
        if (b.type === 'text' && str(b.text).trim()) out.push({ text: str(b.text).trim(), ts });
        if (b.type === 'tool_use' && str(b.name)) out.push({ activity: `→ ${str(b.name).replace(/^mcp__sanctum__/, '')}`, ts });
      }
    }
    if (ev.type === 'result') out.push({ result: { text: str(ev.result).trim(), error: ev.is_error === true } });
    if (ev.type === 'rate_limit_event') out.push({ limits: obj(obj(ev.rate_limit_info).unifiedWindows) as Windows });
    return out;
  },
});

export const antigravityDriver = (bin?: string): AgentDriver => ({
  label: 'Antigravity',
  bin: () => bin ?? join(homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
  firstPrompt: boundPrompt,
  args: ({ prompt, resume, allow }) => ['-p', prompt, '--output-format', 'stream-json',
    '--model', process.env.SANCTUM_AGY_MODEL || 'gemini-3.8-flash-medium',
    '--settings', JSON.stringify({ permissions: {
      allow: [...SANCTUM_TOOLS.map((t) => `mcp(sanctum/${t})`), ...ATLASSIAN_READ.map((t) => `mcp(atlassian/${t})`), ...allow],
      deny: AGY_FORBIDDEN,
    } }),
    ...(resume ? ['--conversation', resume] : [])],
  parse(line) {
    const ev = obj(line);
    const out: TurnEvent[] = [];
    if (ev.event === 'init' && str(obj(ev).conversation_id)) out.push({ session: str(ev.conversation_id) });
    if (ev.event === 'step_update') {
      const s = obj(ev.step_update);
      const info = obj(s.tool_info);
      const params = obj(info.parameters);
      if (s.step_type === 'tool' && s.state === 'ACTIVE') {
        const name = s.tool_name === 'call_mcp_tool' ? str(params.ToolName) : str(s.tool_name);
        out.push({ activity: `→ ${name}` });
      }
      if (s.step_type === 'tool' && s.state === 'ERROR') {
        const message = str(obj(info.error).message);
        const rule = /denied permission for (\S+\(.*?\))(?:\s|$)/.exec(message)?.[1]
          || (/permission (?:check failed|denied)/i.test(message) ? (s.tool_name === 'run_command' ? 'shell' : str(s.tool_name)) : undefined);
        if (rule) out.push({ denied: { rule, detail: JSON.stringify(params).slice(0, 2000) } });
        else if (message) out.push({ activity: `✗ ${message.split('\n')[0]!.slice(0, 160)}` });
      }
      const text = str(s.text) || str(obj(s.agent_response).text);
      if (s.step_type === 'agent_response' && text.trim()) out.push({ text: text.trim() });
    }
    if (ev.event === 'result') {
      const r = obj(ev.result);
      const text = str(r.response).trim();
      const deniedActions = Array.isArray(r.denied_actions) ? r.denied_actions as Obj[] : [];
      for (const da of deniedActions) {
        const action = str(da.action);
        const rule = action === 'command' ? 'shell' : action;
        out.push({ denied: { rule, detail: str(da.display_name) || rule } });
      }
      out.push({ result: { text, error: !text && r.status !== 'SUCCESS' } });
    }
    return out;
  },
});
