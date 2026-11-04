import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestCache, JiraDigest } from './digest.ts';

export function getTwgBin(): string | null {
  // Desligada nos testes (vitest.config.ts): teste nunca fala com o Jira real.
  if (process.env.NOVO_QA_TWG === 'off') return null;
  if (process.env.TWG_BIN && existsSync(process.env.TWG_BIN)) return process.env.TWG_BIN;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const defaultWin = join(localAppData, 'Programs', 'twg', 'bin', 'twg.exe');
    if (existsSync(defaultWin)) return defaultWin;
  }
  return null;
}

export interface RawJiraIssue {
  key: string;
  summary: string;
  description?: unknown;
  issuetype?: { name: string };
  status?: { name: string };
  priority?: { name: string };
  parent?: { key: string; summary?: string; fields?: { summary?: string } };
  components?: { name: string }[];
  labels?: string[];
  issuelinks?: { type?: { name: string }; outwardIssue?: { key: string; fields?: { summary?: string } }; inwardIssue?: { key: string; fields?: { summary?: string } } }[];
  updated?: string;
  url?: string;
}

export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const obj = node as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (Array.isArray(obj.content)) {
    const sep = obj.type === 'paragraph' || obj.type === 'heading' || obj.type === 'bulletList' || obj.type === 'listItem' ? '\n' : '';
    return obj.content.map(adfToText).join(sep);
  }
  return '';
}

/**
 * Saída JSON da twg nos dois formatos: chamada por um agente (variáveis como AI_AGENT/CLAUDECODE no
 * ambiente) ela responde com um envelope que aponta o arquivo (`stdout: "<caminho>"`); num processo
 * sem essas variáveis (ex.: o MCP aberto pelo Antigravity) ela imprime o JSON direto.
 */
export function parseTwgOutput(out: string): unknown {
  const path = /stdout:\s*"([^"]+)"/.exec(out)?.[1]?.replace(/\\\\/g, '\\');
  if (path && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const start = out.indexOf('{');
  if (start >= 0) return JSON.parse(out.slice(start));
  throw new Error('saída da twg sem JSON');
}

export function runTwgJson(args: string[], timeout = 60_000): unknown {
  const bin = getTwgBin();
  if (!bin) throw new Error('CLI twg do Atlassian não encontrada (TWG_BIN ou %LOCALAPPDATA%\\Programs\\twg\\bin\\twg.exe)');
  const out = execFileSync(bin, [...args, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 50 * 1024 * 1024 });
  return parseTwgOutput(out);
}

export function fetchJiraIssueViaTwg(key: string): RawJiraIssue | null {
  if (!getTwgBin()) return null;
  try {
    const content = runTwgJson(['jira', 'workitem', 'get', key], 15_000) as { data?: RawJiraIssue[] };
    return content.data?.[0] ?? null;
  } catch {
    return null;
  }
}

export function toJiraDigest(issue: RawJiraIssue): JiraDigest {
  const desc = typeof issue.description === 'string' ? issue.description : adfToText(issue.description);
  const rules: string[] = [];
  const criteria: string[] = [];
  const lines = desc.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\*?\*?RN\d+/i.test(trimmed)) {
      rules.push(trimmed.replace(/^[*#\s-]+/, '').slice(0, 400));
    }
    if (/^\*?\*?CA\d+/i.test(trimmed) || /^(Given|When|Then|And)\b/i.test(trimmed)) {
      criteria.push(trimmed.replace(/^[*#\s-]+/, '').slice(0, 600));
    }
  }

  const links = (issue.issuelinks ?? []).map((l) => {
    const out = l.outwardIssue ?? l.inwardIssue;
    return {
      key: out?.key ?? '',
      relation: l.type?.name ?? 'relates to',
      title: out?.fields?.summary?.slice(0, 300),
    };
  }).filter((l) => l.key);

  const parentTitle = issue.parent?.summary ?? issue.parent?.fields?.summary;

  return {
    key: issue.key,
    title: issue.summary.slice(0, 300),
    type: issue.issuetype?.name?.slice(0, 50) ?? 'Tarefa',
    status: issue.status?.name?.slice(0, 80) ?? 'Backlog',
    priority: issue.priority?.name?.slice(0, 50),
    parent: issue.parent ? { key: issue.parent.key, title: parentTitle?.slice(0, 300) } : undefined,
    components: (issue.components ?? []).map((c) => c.name.slice(0, 100)),
    labels: (issue.labels ?? []).map((l) => l.slice(0, 100)),
    summary: desc ? desc.slice(0, 1200) : issue.summary.slice(0, 1200),
    acceptanceCriteria: criteria.length ? criteria.slice(0, 30) : [issue.summary.slice(0, 600)],
    businessRules: rules.slice(0, 30),
    roles: ['aluno', 'professor'],
    openQuestions: [],
    links: links.slice(0, 15),
    attachments: [],
    figma: [],
    confluence: [],
    comments: [],
    environmentHints: ['guruja-dev'],
  };
}

export function autoSyncJiraCard(key: string, cache: DigestCache): boolean {
  const issue = fetchJiraIssueViaTwg(key);
  if (!issue) return false;
  const version = issue.updated ?? new Date().toISOString();
  const digest = toJiraDigest(issue);
  cache.put('jira', key, version, digest);
  return true;
}
