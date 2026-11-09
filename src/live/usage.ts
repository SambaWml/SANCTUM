import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript } from '../metrics/transcripts.ts';

/**
 * Consumo do plano de cada agente para o painel ao vivo. Nenhum agente publica limite em tokens:
 * o que existe é a porcentagem usada de cada janela (5 h e 7 dias) e o horário de reset.
 * - Claude Code: a % só chega na entrada da linha de status; `.claude/statusline.mjs` grava em
 *   data/usage-limits.json. Tokens vêm dos transcripts (~/.claude/projects).
 * - Codex: os rollouts (~/.codex/sessions/**.jsonl) trazem eventos token_count com o uso da chamada
 *   e rate_limits (primary = 5 h, secondary = semana).
 * - Antigravity: não guarda limite nem uso em formato legível no computador (só no servidor).
 * Os formatos não são API pública — tudo que depende deles fica aqui. Leitura incremental: cada
 * arquivo é lido só no trecho acrescentado desde a última vez.
 */

export type UsageAgent = 'claude' | 'codex' | 'antigravity';
/** renewedAt: a janela lida já renovou (o reset passou); usedPct vira 0 só se o agente grava a % a cada uso. */
export interface UsageWindow { usedPct: number | null; resetsAt: string | null; renewedAt: string | null; spent: number; cacheRead: number; calls: number }
export interface AgentUsage { agent: UsageAgent; available: boolean; note?: string; fiveHour: UsageWindow; sevenDay: UsageWindow; limitsUpdatedAt: string | null }
export interface UsageState { agents: AgentUsage[] }

export interface UsageSources { claudeProjectsDir: string; claudeLimitsFile: string; codexSessionsDir: string }

interface Call { ts: number; input: number; cacheWrite: number; output: number; cacheRead: number }
interface Limit { usedPct: number; resetsAt: number }
interface Limits { five?: Limit; week?: Limit; updatedAt: string | null }

const WEEK = 7 * 86400_000;
const FIVE_HOURS = 5 * 3600_000;
const CHUNK = 16 * 1024 * 1024;

export class UsageMeter {
  private readonly claude = new TailReader();
  private readonly codex = new TailReader();
  private readonly claudeCalls = new Map<string, Call>();
  private readonly codexCalls = new Map<string, Call>();
  private codexLimits: Limits & { ts: string } = { updatedAt: null, ts: '' };
  private lastScan = 0;

  constructor(
    private readonly sources: UsageSources,
    private readonly now: () => Date = () => new Date(),
    private readonly scanEveryMs = 30_000,
  ) {}

  state(): UsageState {
    const now = this.now().getTime();
    if (now - this.lastScan >= this.scanEveryMs) {
      this.scan(now);
      this.lastScan = now;
    }
    const empty: Limits = { updatedAt: null };
    return {
      agents: [
        // Claude: a % só é regravada por sessões deste projeto; uso em outro projeto não aparece, então reset vencido = sem leitura.
        agentUsage('claude', this.claudeCalls, this.claudeLimits() ?? empty, now, false),
        // Codex: toda chamada grava a %; se o reset passou e não há registro novo, a janela está zerada.
        agentUsage('codex', this.codexCalls, this.codexLimits, now, true),
        { ...agentUsage('antigravity', new Map(), empty, now, false), available: false, note: 'o Antigravity não guarda limite nem tokens no computador' },
      ],
    };
  }

  private claudeLimits(): Limits | null {
    try {
      if (!existsSync(this.sources.claudeLimitsFile)) return null;
      const f = JSON.parse(readFileSync(this.sources.claudeLimitsFile, 'utf8')) as {
        five_hour?: { used_percentage?: number; resets_at?: number }; seven_day?: { used_percentage?: number; resets_at?: number }; updatedAt?: string;
      };
      const lim = (w?: { used_percentage?: number; resets_at?: number }) =>
        typeof w?.used_percentage === 'number' && typeof w.resets_at === 'number' ? { usedPct: w.used_percentage, resetsAt: w.resets_at } : undefined;
      return { five: lim(f.five_hour), week: lim(f.seven_day), updatedAt: f.updatedAt ?? null };
    } catch {
      return null; // arquivo sendo regravado
    }
  }

  private scan(now: number): void {
    const since = now - WEEK;
    for (const file of recentJsonl(this.sources.claudeProjectsDir, since)) {
      this.claude.read(file, (text) => {
        for (const c of parseTranscript(text)) {
          // Uma chamada pode vir em pedaços lidos em momentos diferentes: a saída só cresce.
          this.claudeCalls.set(c.messageId, {
            ts: Date.parse(c.ts), input: c.usage.input_tokens, cacheWrite: c.usage.cache_creation_input_tokens,
            output: Math.max(this.claudeCalls.get(c.messageId)?.output ?? 0, c.usage.output_tokens), cacheRead: c.usage.cache_read_input_tokens,
          });
        }
      });
    }
    for (const file of recentJsonl(this.sources.codexSessionsDir, since)) {
      this.codex.read(file, (text) => {
        for (const raw of text.split('\n')) {
          if (!raw.includes('"token_count"')) continue;
          let line: CodexLine;
          try { line = JSON.parse(raw) as CodexLine; } catch { continue; }
          const p = line.payload;
          if (p?.type !== 'token_count' || !line.timestamp) continue;
          const last = p.info?.last_token_usage, total = p.info?.total_token_usage;
          // O mesmo token_count pode ser emitido de novo; o total acumulado da sessão identifica a chamada.
          if (last && total) {
            const cached = last.cached_input_tokens ?? 0;
            this.codexCalls.set(`${file}:${total.total_tokens}`, {
              ts: Date.parse(line.timestamp), input: Math.max(0, (last.input_tokens ?? 0) - cached),
              cacheWrite: last.cache_write_input_tokens ?? 0, output: last.output_tokens ?? 0, cacheRead: cached,
            });
          }
          const rl = p.rate_limits;
          if (rl && line.timestamp >= this.codexLimits.ts) {
            const lim = (w?: { used_percent?: number; resets_at?: number }) =>
              typeof w?.used_percent === 'number' && typeof w.resets_at === 'number' ? { usedPct: w.used_percent, resetsAt: w.resets_at } : undefined;
            this.codexLimits = { five: lim(rl.primary), week: lim(rl.secondary), updatedAt: line.timestamp, ts: line.timestamp };
          }
        }
      });
    }
    for (const calls of [this.claudeCalls, this.codexCalls]) for (const [id, c] of calls) if (c.ts < since) calls.delete(id);
  }
}

interface CodexUsage { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number; total_tokens?: number }
interface CodexLine {
  timestamp?: string;
  payload?: {
    type?: string;
    info?: { last_token_usage?: CodexUsage; total_token_usage?: CodexUsage } | null;
    rate_limits?: { primary?: { used_percent?: number; resets_at?: number }; secondary?: { used_percent?: number; resets_at?: number } } | null;
  };
}

function agentUsage(agent: UsageAgent, calls: Map<string, Call>, limits: Limits, now: number, expiredIsZero: boolean): AgentUsage {
  const window = (ms: number, l?: Limit): UsageWindow => {
    let spent = 0, cacheRead = 0, n = 0;
    for (const c of calls.values()) if (c.ts >= now - ms) { spent += c.input + c.cacheWrite + c.output; cacheRead += c.cacheRead; n++; }
    const live = l !== undefined && l.resetsAt * 1000 > now;
    const renewedAt = l !== undefined && !live ? new Date(l.resetsAt * 1000).toISOString() : null;
    return { usedPct: live ? l.usedPct : renewedAt && expiredIsZero ? 0 : null, resetsAt: live ? new Date(l.resetsAt * 1000).toISOString() : null, renewedAt, spent, cacheRead, calls: n };
  };
  return { agent, available: true, fiveHour: window(FIVE_HOURS, limits.five), sevenDay: window(WEEK, limits.week), limitsUpdatedAt: limits.updatedAt };
}

/** Lê só o trecho novo de cada arquivo; a linha ainda sendo escrita fica para a próxima leitura. */
class TailReader {
  private readonly files = new Map<string, { offset: number; rest: string }>();

  read(file: string, onLines: (text: string) => void): void {
    const seen = this.files.get(file) ?? { offset: 0, rest: '' };
    this.files.set(file, seen);
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size < seen.offset) { seen.offset = 0; seen.rest = ''; } // arquivo recriado
      // Em blocos: rollout do Codex passa de 500 MB, além do limite de uma string.
      const buf = Buffer.alloc(Math.min(CHUNK, Math.max(0, size - seen.offset)));
      while (seen.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - seen.offset), seen.offset);
        if (n <= 0) break;
        seen.offset += n;
        const text = seen.rest + buf.toString('utf8', 0, n);
        const cut = text.lastIndexOf('\n');
        // Linha gigante sem fim (ex.: imagem embutida) não acumula sem limite: é descartada.
        seen.rest = text.length - cut > CHUNK ? '' : text.slice(cut + 1);
        if (cut >= 0) onLines(text.slice(0, cut + 1));
      }
    } finally {
      closeSync(fd);
    }
  }
}

/** Arquivos .jsonl alterados desde `since`, em qualquer subpasta. */
function recentJsonl(dir: string, since: number): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'memory' || name === 'tool-results') continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    // Pasta não muda de data quando um arquivo dela cresce: percorre todas.
    if (st.isDirectory()) out.push(...recentJsonl(path, since));
    else if (name.endsWith('.jsonl') && st.mtimeMs >= since) out.push(path);
  }
  return out;
}
