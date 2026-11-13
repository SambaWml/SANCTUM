import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGY_FORBIDDEN, SANCTUM_TOOLS } from '../src/live/agents.ts';

/**
 * Contrato entre os guias dos agentes e o código (decisão 41): o roteiro mora em docs/agents/ e é
 * neutro; .claude/, .agents/ e .codex/ só apontam; toda ferramenta citada existe; a lista de
 * ferramentas sensíveis é a mesma em todas as camadas. Quebrou aqui = os agentes vão divergir.
 */

const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.md') ? [`${dir}/${e.name}`] : []));

/** Ferramentas registradas no servidor MCP: `tool('nome', ...)` em src/mcp. */
function registeredTools(): Set<string> {
  const names = new Set<string>(['permission_prompt']);
  const scan = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) scan(`${dir}/${e.name}`);
      else if (e.name.endsWith('.ts')) for (const m of read(`${dir}/${e.name}`).matchAll(/\btool\(\s*'([a-z_]+)'/g)) names.add(m[1]!);
    }
  };
  scan('src/mcp');
  return names;
}

const GUIDES = walk('docs/agents');
const NEUTRAL = GUIDES.filter((p) => !p.startsWith('docs/agents/clients/'));
const ADAPTERS = [...walk('.claude/skills'), ...walk('.claude/agents'), ...walk('.agents/skills')];

// Palavras com underscore que não são ferramentas (campos, enums, configuração).
const NOT_TOOLS = new Set(['approval_mode', 'tool_timeout_sec', 'startup_timeout_sec', 'default_tools_approval_mode', 'test_data', 'explain_remove',
  'run_id', 'issue_key', 'call_mcp_tool', 'read_file', 'write_file', 'edit_file', 'run_command', 'open_browser_url', 'read_browser_page', 'browser_']);

describe('contrato dos guias de agente', () => {
  const tools = registeredTools();

  it('o servidor registra as ferramentas conhecidas', () => {
    expect(tools.size).toBeGreaterThan(40);
    for (const t of ['run_start', 'plan_save', 'plan_approve', 'act', 'verify', 'charter_end', 'system_map_save', 'question_answer']) expect(tools.has(t)).toBe(true);
  });

  it('toda ferramenta citada nos guias existe no servidor', () => {
    const missing: string[] = [];
    for (const p of [...GUIDES, ...ADAPTERS, 'AGENTS.md', 'CLAUDE.md']) {
      for (const m of read(p).matchAll(/`(?:mcp__sanctum__)?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:\([^`]*\))?`/g)) {
        const name = m[1]!;
        if (tools.has(name) || NOT_TOOLS.has(name) || [...NOT_TOOLS].some((n) => n.endsWith('_') && name.startsWith(n))) continue;
        missing.push(`${p}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('adaptadores e guias apontam para arquivos que existem', () => {
    const broken: string[] = [];
    for (const p of [...ADAPTERS, ...GUIDES, 'AGENTS.md', 'CLAUDE.md', 'src/live/agents.ts']) {
      const text = read(p);
      for (const m of text.matchAll(/(?:docs\/agents\/[\w\-./]+\.md|\b(?:references|roles|clients)\/[\w\-]+\.md|\.\.\/references\/[\w\-]+\.md)/g)) {
        const ref = m[0];
        // Convenção: `references/x.md`, `roles/x.md` e `clients/x.md` partem de docs/agents/; `../x` é relativo ao arquivo.
        const target = ref.startsWith('docs/') ? ref
          : ref.startsWith('../') ? resolve(join(ROOT, dirname(p)), ref).slice(ROOT.length + 1).replace(/\\/g, '/')
          : `docs/agents/${ref}`;
        if (!existsSync(join(ROOT, target))) broken.push(`${p} → ${ref}`);
      }
    }
    expect(broken).toEqual([]);
    for (const a of ADAPTERS) expect(read(a), a).toMatch(/docs\/agents\//);
  });

  it('o roteiro neutro não fala de cliente, subagente, comando com barra nem do modo jogo', () => {
    const bad: string[] = [];
    const forbidden = /\b(Claude|Codex|Antigravity|Gemini|Cursor|subagente|\$ARGUMENTS|mcp__)\b|\/(qa|qa-resume|retest|automate|analisar)\b|\b(bestiário|glória|conquista|caçada|XP)\b/;
    for (const p of NEUTRAL) for (const [i, line] of read(p).split('\n').entries()) {
      const m = forbidden.exec(line);
      if (m) bad.push(`${p}:${i + 1}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it('a lista de ferramentas sensíveis é a mesma em todas as camadas', () => {
    const expected = ['act_approved', 'jira_comment', 'jira_create_issue', 'jira_transition', 'plan_approve', 'question_answer'];
    const settings = JSON.parse(read('.claude/settings.json')) as { permissions: { ask: string[] } };
    expect(settings.permissions.ask.map((s) => s.replace('mcp__sanctum__', '')).sort()).toEqual(expected);
    const codex = [...read('.codex/config.toml').matchAll(/\[mcp_servers\.sanctum\.tools\.([a-z_]+)\]\s*\napproval_mode = "prompt"/g)].map((m) => m[1]!).sort();
    expect(codex).toEqual(expected);
    const tooling = /SENSITIVE = new Set\(\[([^\]]+)\]\)/.exec(read('src/mcp/tooling.ts'))![1]!.match(/[a-z_]+/g)!.sort();
    expect(tooling).toEqual(expected);
    const rule = /SENSITIVE_RULE = \/\^mcp\\\(sanctum\\\/\(([a-z_|]+)\)/.exec(read('src/live/missions.ts'))![1]!.split('|').sort();
    expect(rule).toEqual(expected);
    for (const t of expected) expect(SANCTUM_TOOLS, `${t} liberado sem pedido`).not.toContain(t);
    const agents = read('AGENTS.md');
    for (const t of expected) expect(agents).toContain(`\`${t}\``);
  });

  it('o que é proibido ao Antigravity está escrito no guia do cliente', () => {
    const guide = read('docs/agents/clients/antigravity.md');
    for (const t of ['run_command', 'open_browser_url', 'schedule']) expect(guide).toContain(t);
    expect(AGY_FORBIDDEN).toContain('schedule');
  });

  it('as skills e agentes do Claude declaram só ferramentas registradas', () => {
    for (const p of walk('.claude/agents')) {
      const line = /^tools: (.*)$/m.exec(read(p))![1]!;
      for (const t of line.split(',').map((s) => s.trim()).filter((s) => s.startsWith('mcp__sanctum__'))) {
        expect(tools.has(t.replace('mcp__sanctum__', '')), `${p}: ${t}`).toBe(true);
      }
    }
  });
});
