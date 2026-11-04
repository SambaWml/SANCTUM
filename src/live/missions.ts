import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../state/db.ts';
import {
  AGY_FORBIDDEN, antigravityDriver, claudeDriver,
  type AgentDriver, type MissionAgent, type MissionKind, type MissionTarget, type TurnEvent, type Windows,
} from './agents.ts';
import { createPrompt, describeTool } from './prompts.ts';

/**
 * Missões lançadas pela Central de Caça: o agente roda em segundo plano, um processo por turno,
 * desacoplado do painel e com a saída em data/missions/. Cada resposta do usuário no painel
 * continua a mesma conversa. Como cada agente roda e pede permissão está em agents.ts.
 */

export { ALLOWED_TOOLS, missionCommand } from './agents.ts';
export type { MissionAgent, MissionKind, MissionTarget } from './agents.ts';
export type MissionStatus = 'RUNNING' | 'WAITING' | 'DONE' | 'FAILED' | 'STOPPED';

export interface MissionRow {
  id: string; agent: MissionAgent; target: string; kind: MissionKind; objective: string | null; status: MissionStatus;
  session_id: string | null; pid: number | null; last_message: string | null; error: string | null; created_at: string; updated_at: string;
  log_path: string | null; run_id: string | null; archived_at: string | null;
}
export interface MissionMessage {
  id: number;
  mission_id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  ts: string;
}
export interface MissionView extends MissionRow {
  runId: string | null;
  runStatus: string | null;
  activity: { ts: string; text: string }[];
  messages: MissionMessage[];
}

export interface MissionDeps {
  db: Db; rootDir: string;
  claudeBin?: string;
  agyBin?: string;
  /** Só para testes: drivers no lugar dos reais. */
  drivers?: Partial<Record<MissionAgent, AgentDriver>>;
  /** data/usage-limits.json: recebe o uso do plano informado pelo Claude (medidor do painel). */
  limitsFile?: string;
  /** Pasta da saída de cada turno (padrão data/missions). */
  logDir?: string;
  spawnFn?: typeof spawn;
  killTree?: (pid: number) => void;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}

export class MissionError extends Error {}

/** Leitura em andamento do turno de uma missão (a saída fica num arquivo, não num pipe). */
interface Tail {
  path: string; offset: number; rest: string; lastText: string;
  result: { text: string; error: boolean } | null;
  denied: { rule: string; detail: string }[];
}

/** Regras negadas que o painel nunca libera: o turno segue com o aviso, sem perguntar. */
const forbidden = (rule: string) => AGY_FORBIDDEN.includes(rule.replace(/\(.*$/, ''));
/** Retomadas automáticas seguidas (só ações proibidas) antes de parar e chamar o usuário. */
const MAX_AUTO_RESUME = 2;

export class MissionManager {
  private readonly tails = new Map<string, Tail>();
  private readonly activity = new Map<string, { ts: string; text: string }[]>();
  private readonly autoResumes = new Map<string, number>();
  private readonly drivers: Record<MissionAgent, AgentDriver>;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MissionDeps) {
    this.now = deps.now ?? (() => new Date());
    this.drivers = {
      claude: deps.drivers?.claude ?? claudeDriver(deps.claudeBin),
      antigravity: deps.drivers?.antigravity ?? antigravityDriver(deps.agyBin),
    };
  }

  /**
   * O agente roda desacoplado do painel: fechar ou reiniciar o painel não interrompe o turno.
   * Ao voltar, o painel relê a saída de cada missão em andamento e segue acompanhando.
   */
  start(everyMs = 1000): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), everyMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Missões RUNNING sem saída para acompanhar (lançadas antes deste formato) viram FAILED. */
  recover(): void {
    this.deps.db.prepare(`UPDATE missions SET status = 'FAILED', error = 'o turno foi interrompido; responda para continuar', pid = NULL, updated_at = ?
                          WHERE status = 'RUNNING' AND (log_path IS NULL OR pid IS NULL)`).run(this.ts());
  }

  launch(input: { agent: MissionAgent; target: MissionTarget; kind: MissionKind; objective?: string }): MissionRow {
    if (!this.drivers[input.agent]) throw new MissionError(`agente ${input.agent} não é lançado pelo painel`);
    if (input.target.kind === 'url' && (input.kind === 'retest' || input.kind === 'resume')) throw new MissionError('reteste e retomada exigem um card');
    const target = input.target.kind === 'card' ? input.target.key : input.target.url;
    const busy = this.deps.db.prepare(`SELECT id FROM missions WHERE target = ? AND status = 'RUNNING'`).get(target) as { id: string } | undefined;
    if (busy) throw new MissionError(`já existe a missão ${busy.id} rodando para ${target}`);
    const ts = this.ts();
    const stamp = ts.replace(/[-:]/g, '').slice(0, 15);
    let id = `M-${stamp}`;
    for (let n = 2; this.deps.db.prepare('SELECT 1 FROM missions WHERE id = ?').get(id); n++) id = `M-${stamp}-${n}`;
    const objective = input.objective?.trim() || null;
    this.deps.db.prepare(`INSERT INTO missions (id, agent, target, kind, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?)`)
      .run(id, input.agent, target, input.kind, objective, ts, ts);
    this.addMessage(id, 'user', objective ? `Lançamento: ${objective}` : `Iniciou missão ${input.kind.toUpperCase()} para ${target}`, ts);
    this.turn(id, this.drivers[input.agent].firstPrompt(input.target, input.kind, objective ?? undefined));
    return this.get(id);
  }

  /** Resposta do usuário: continua a conversa. approvePlan grava a aprovação antes, liberando o plan_approve. */
  reply(id: string, text: string, opts: { approvePlan?: boolean } = {}): MissionRow {
    const m = this.get(id);
    if (m.status === 'RUNNING') throw new MissionError('o agente ainda está trabalhando; espere ele terminar o turno');
    if (!m.session_id) throw new MissionError('missão sem conversa para continuar; lance de novo');
    const message = text.trim() || (opts.approvePlan ? 'Plano aprovado. Pode seguir.' : '');
    if (!message) throw new MissionError('escreva a resposta');
    if (opts.approvePlan) createPrompt(this.deps.db, { missionId: id, kind: 'plan', summary: 'Plano aprovado pelo painel', decision: 'allow' }, this.now());
    // Pedidos de permissão sem resposta perdem o sentido quando o usuário responde outra coisa.
    this.deps.db.prepare(`UPDATE prompts SET status = 'EXPIRED' WHERE mission_id = ? AND status = 'PENDING'`).run(id);
    this.autoResumes.delete(id);
    this.push(id, `você: ${message}`);
    this.addMessage(id, 'user', message);
    this.resume(id, message, m.agent === 'antigravity' && opts.approvePlan ? ['mcp(novo-qa/plan_approve)'] : []);
    return this.get(id);
  }

  stop(id: string): MissionRow {
    const m = this.get(id);
    if (m.pid && m.status === 'RUNNING') (this.deps.killTree ?? killTree)(m.pid);
    this.tails.delete(id);
    // Pedidos que ficaram esperando não valem mais.
    this.deps.db.prepare(`UPDATE prompts SET status = 'EXPIRED' WHERE mission_id = ? AND status = 'PENDING'`).run(id);
    if (m.status === 'RUNNING' || m.status === 'WAITING') {
      this.deps.db.prepare(`UPDATE missions SET status = 'STOPPED', pid = NULL, updated_at = ? WHERE id = ?`).run(this.ts(), id);
    }
    this.push(id, 'missão parada pelo usuário');
    return this.get(id);
  }

  /** Missão parada ou que falhou: continua a mesma conversa de onde parou. */
  resumeMission(id: string): MissionRow {
    const m = this.get(id);
    if (m.status !== 'STOPPED' && m.status !== 'FAILED') throw new MissionError('só missão pausada (parada ou que falhou) é retomada; as outras seguem pelo próprio card');
    return this.reply(id, 'Continue de onde parou, seguindo o roteiro.');
  }

  /** Tira a missão do painel (histórico, run e evidências ficam). Em andamento, pare antes. */
  archive(id: string): MissionRow {
    const m = this.get(id);
    if (m.status === 'RUNNING') throw new MissionError('a missão está trabalhando: pare antes de excluir');
    if (m.status === 'WAITING') this.stop(id);
    this.deps.db.prepare('UPDATE missions SET archived_at = ?, updated_at = ? WHERE id = ?').run(this.ts(), this.ts(), id);
    return this.get(id);
  }

  /** Tira um run do painel (ex.: parado sem ninguém operando). Não aborta nem apaga nada. */
  hideRun(runId: string): void {
    if (!this.deps.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId)) throw new MissionError(`run ${runId} não existe`);
    this.deps.db.prepare('INSERT OR REPLACE INTO hidden_runs (run_id, hidden_at) VALUES (?, ?)').run(runId, this.ts());
  }

  /** Oculta todos os runs inativos (concluídos, abortados) do painel de uma vez. */
  hideAllInactive(): number {
    const rows = this.deps.db.prepare(`SELECT id FROM runs WHERE status NOT IN ('PLANNING','AWAITING_APPROVAL','EXECUTING') AND id NOT IN (SELECT run_id FROM hidden_runs)`).all() as { id: string }[];
    const ts = this.ts();
    const insert = this.deps.db.prepare('INSERT OR REPLACE INTO hidden_runs (run_id, hidden_at) VALUES (?, ?)');
    for (const r of rows) insert.run(r.id, ts);
    return rows.length;
  }

  get(id: string): MissionRow {
    const m = this.deps.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as MissionRow | undefined;
    if (!m) throw new MissionError(`missão ${id} não existe`);
    return m;
  }

  /** Missões não excluídas: as ativas e pausadas sempre; as concluídas dos últimos 7 dias. */
  list(): MissionView[] {
    this.link();
    const since = new Date(this.now().getTime() - 7 * 86400_000).toISOString();
    const rows = this.deps.db.prepare(`SELECT * FROM missions WHERE archived_at IS NULL AND (updated_at >= ? OR status IN ('RUNNING','WAITING','STOPPED','FAILED'))
                                       ORDER BY created_at DESC LIMIT 40`).all(since) as unknown as MissionRow[];
    return rows.map((m) => {
      const run = m.run_id ? this.deps.db.prepare('SELECT status FROM runs WHERE id = ?').get(m.run_id) as { status: string } | undefined : undefined;
      let messages: MissionMessage[] = [];
      try {
        messages = this.deps.db.prepare('SELECT * FROM mission_messages WHERE mission_id = ? ORDER BY id ASC LIMIT 100').all(m.id) as unknown as MissionMessage[];
      } catch {
        // Tabela ainda não criada ou em migração
      }
      if (!messages.length) {
        if (m.objective) messages.push({ id: 0, mission_id: m.id, role: 'user', text: m.objective, ts: m.created_at });
        const act = this.activity.get(m.id) ?? [];
        for (let i = 0; i < act.length; i++) {
          const item = act[i]!;
          if (item.text.startsWith('você: ')) {
            messages.push({ id: 10 + i, mission_id: m.id, role: 'user', text: item.text.replace(/^você:\s*/, ''), ts: item.ts });
          }
        }
        if (m.last_message) messages.push({ id: 999, mission_id: m.id, role: 'agent', text: m.last_message, ts: m.updated_at });
        else if (m.error) messages.push({ id: 999, mission_id: m.id, role: 'agent', text: m.error, ts: m.updated_at });
      }
      return { ...m, runId: m.run_id, runStatus: run?.status ?? null, activity: this.activity.get(m.id) ?? [], messages };
    });
  }

  /** Lê o que cada turno em andamento escreveu, fecha o que terminou e continua o que já tem resposta. */
  poll(): void {
    this.link();

    // 1. Conclui missões vinculadas cujo run de testes já atingiu COMPLETED e o processo não está mais executando
    const openWithRun = this.deps.db.prepare(`SELECT * FROM missions WHERE status IN ('WAITING', 'RUNNING') AND run_id IS NOT NULL`).all() as unknown as MissionRow[];
    for (const m of openWithRun) {
      if (this.runCompleted(m.id)) {
        const isRunning = m.status === 'RUNNING' && m.pid && (this.deps.isAlive ?? isAlive)(m.pid);
        if (!isRunning) {
          this.deps.db.prepare(`UPDATE missions SET status = 'DONE', pid = NULL, updated_at = ? WHERE id = ?`).run(this.ts(), m.id);
          this.push(m.id, 'missão concluída com sucesso');
          this.addMessage(m.id, 'system', '🏁 Missão finalizada! Todos os cenários e relatório foram concluídos.');
        }
      }
    }

    const running = this.deps.db.prepare(`SELECT * FROM missions WHERE status = 'RUNNING' AND log_path IS NOT NULL AND pid IS NOT NULL`).all() as unknown as MissionRow[];
    for (const m of running) {
      let tail = this.tails.get(m.id);
      if (!tail || tail.path !== m.log_path) {
        tail = { path: m.log_path!, offset: 0, rest: '', lastText: '', result: null, denied: [] };
        this.tails.set(m.id, tail);
      }
      this.read(m, tail);
      const alive = (this.deps.isAlive ?? isAlive)(m.pid!);
      if (tail.result || !alive) {
        if (!alive) this.read(m, tail); // o que foi escrito no último instante
        this.finish(m, tail);
      }
    }
    // Antigravity: todos os pedidos de permissão do turno respondidos → continua com as regras liberadas.
    const waiting = this.deps.db.prepare(`SELECT * FROM missions WHERE status = 'WAITING' AND agent = 'antigravity'`).all() as unknown as MissionRow[];
    for (const m of waiting) {
      const answered = this.deps.db.prepare(`SELECT id, tool, decision FROM prompts WHERE mission_id = ? AND kind = 'permission' AND status = 'ANSWERED'`).all(m.id) as { id: number; tool: string; decision: 'allow' | 'deny' }[];
      const pending = this.deps.db.prepare(`SELECT 1 FROM prompts WHERE mission_id = ? AND status = 'PENDING'`).get(m.id);
      if (!answered.length || pending) continue;
      const allowed = answered.filter((a) => a.decision === 'allow').map((a) => a.tool);
      const denied = answered.filter((a) => a.decision === 'deny').map((a) => a.tool);
      for (const a of answered) this.deps.db.prepare(`UPDATE prompts SET status = 'USED' WHERE id = ?`).run(a.id);
      // Ação sensível permitida: vale uma vez (o novo-qa confere a concessão ao executar).
      for (const rule of allowed) {
        const tool = /^mcp\(novo-qa\/(plan_approve|act_approved|jira_create_issue|jira_comment|jira_transition)\)$/.exec(rule)?.[1];
        if (tool) createPrompt(this.deps.db, { missionId: m.id, kind: 'plan', tool, summary: `Concessão única de ${tool} pelo painel`, decision: 'allow' }, this.now());
      }
      const message = [
        allowed.length ? `O usuário permitiu pelo painel: ${allowed.join(', ')}. Continue de onde parou.` : '',
        denied.length ? `O usuário negou: ${denied.join(', ')}. Siga sem isso, sem contornar.` : '',
      ].filter(Boolean).join(' ');
      this.push(m.id, allowed.length ? `você permitiu: ${allowed.join(', ')}` : `você negou: ${denied.join(', ')}`);
      this.resume(m.id, message, allowed);
    }
  }

  private resume(id: string, message: string, allow: string[]): void {
    const m = this.get(id);
    this.deps.db.prepare(`UPDATE missions SET status = 'RUNNING', error = NULL, updated_at = ? WHERE id = ?`).run(this.ts(), id);
    this.turn(id, message, m.session_id ?? undefined, allow);
  }

  /** Liga a missão ao run que o agente abriu (Claude: NOVO_QA_MISSION no MCP; Antigravity: mesmo alvo e cliente, depois do lançamento). */
  private link(): void {
    const open = this.deps.db.prepare(`SELECT * FROM missions WHERE run_id IS NULL AND archived_at IS NULL`).all() as unknown as MissionRow[];
    for (const m of open) {
      const run = (m.agent === 'claude'
        ? this.deps.db.prepare(`SELECT id FROM runs WHERE json_extract(agent, '$.mission') = ? ORDER BY started_at DESC LIMIT 1`).get(m.id)
        : this.deps.db.prepare(`SELECT id FROM runs WHERE started_at >= ? AND lower(COALESCE(json_extract(agent, '$.client'), '')) LIKE ?
                                AND (issue_key = ? OR (? LIKE 'http%' AND issue_key LIKE 'EXPLORA-%'))
                                AND id NOT IN (SELECT run_id FROM missions WHERE run_id IS NOT NULL) ORDER BY started_at LIMIT 1`)
          .get(m.created_at, `%${m.agent}%`, m.target, m.target)) as { id: string } | undefined;
      if (run) this.deps.db.prepare('UPDATE missions SET run_id = ? WHERE id = ?').run(run.id, m.id);
    }
  }

  private turn(id: string, prompt: string, resume?: string, allow: string[] = []): void {
    const m = this.get(id);
    const driver = this.drivers[m.agent];
    const dir = this.deps.logDir ?? join(this.deps.rootDir, 'data', 'missions');
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `${id}-${Date.now()}`);
    const out = openSync(`${base}.jsonl`, 'a');
    const err = openSync(`${base}.err`, 'a');
    let pid: number | undefined;
    try {
      const proc = (this.deps.spawnFn ?? spawn)(driver.bin(), driver.args({ prompt, resume, allow }), {
        cwd: this.deps.rootDir, windowsHide: true, detached: true, stdio: ['ignore', out, err],
        // O MCP iniciado pelo próprio agente herda NOVO_QA_MISSION (liga o run e os pedidos ao painel).
        env: { ...process.env, NOVO_QA_MISSION: id, MCP_TOOL_TIMEOUT: String(45 * 60_000) },
      });
      proc.on('error', (e) => this.deps.db.prepare(`UPDATE missions SET status = 'FAILED', pid = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING'`)
        .run(`não foi possível iniciar o ${driver.label}: ${e.message}`, this.ts(), id));
      proc.unref();
      pid = proc.pid;
    } finally {
      closeSync(out);
      closeSync(err);
    }
    this.tails.delete(id);
    this.deps.db.prepare('UPDATE missions SET pid = ?, log_path = ?, updated_at = ? WHERE id = ?').run(pid ?? null, `${base}.jsonl`, this.ts(), id);
  }

  private read(m: MissionRow, tail: Tail): void {
    if (!existsSync(tail.path)) return;
    const size = statSync(tail.path).size;
    if (size <= tail.offset) return;
    const fd = openSync(tail.path, 'r');
    const buf = Buffer.alloc(size - tail.offset);
    try { readSync(fd, buf, 0, buf.length, tail.offset); } finally { closeSync(fd); }
    tail.offset = size;
    const lines = (tail.rest + buf.toString('utf8')).split('\n');
    tail.rest = lines.pop() ?? '';
    for (const line of lines) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      for (const ev of this.drivers[m.agent].parse(parsed)) this.apply(m.id, tail, ev);
    }
  }

  private apply(id: string, tail: Tail, ev: TurnEvent): void {
    const at = ev.ts ?? this.ts();
    if (ev.session) this.deps.db.prepare('UPDATE missions SET session_id = ? WHERE id = ? AND session_id IS NULL').run(ev.session, id);
    if (ev.activity) this.push(id, ev.activity, at);
    if (ev.text) { tail.lastText = ev.text; this.push(id, ev.text.split('\n')[0]!.slice(0, 200), at); }
    if (ev.denied && !tail.denied.some((d) => d.rule === ev.denied!.rule)) {
      tail.denied.push(ev.denied);
      this.push(id, `⛔ sem permissão: ${ev.denied.rule}`, at);
    }
    if (ev.result) tail.result = { text: ev.result.text || tail.lastText, error: ev.result.error };
    if (ev.limits && this.deps.limitsFile) writeLimits(this.deps.limitsFile, ev.limits);
  }

  private finish(m: MissionRow, tail: Tail): void {
    this.tails.delete(m.id);
    const current = this.get(m.id);
    if (current.status !== 'RUNNING' || current.pid !== m.pid) return; // parada pelo usuário ou turno mais novo
    const set = (status: MissionStatus, message: string | null, error: string | null) => {
      this.deps.db.prepare(`UPDATE missions SET status = ?, pid = NULL, last_message = COALESCE(?, last_message), error = ?, updated_at = ? WHERE id = ?`)
        .run(status, message, error, this.ts(), m.id);
      if (message) this.addMessage(m.id, 'agent', message);
      else if (error) this.addMessage(m.id, 'agent', `Erro: ${error}`);
    };

    // Antigravity: ação negada por falta de permissão encerra o turno. Vira pedido no painel
    // (ou, se o NOVO QA proíbe, segue com o aviso, sem perguntar).
    if (tail.denied.length) {
      const ask = tail.denied.filter((d) => !forbidden(d.rule));
      const blocked = tail.denied.filter((d) => forbidden(d.rule)).map((d) => d.rule);
      for (const d of ask) createPrompt(this.deps.db, { missionId: m.id, kind: 'permission', tool: d.rule, summary: describeRule(d.rule, d.detail), input: safeJson(d.detail) }, this.now());
      const note = blocked.length ? `O NOVO QA proíbe: ${blocked.join(', ')} (operar o sistema por fora das ferramentas do novo-qa). Use as ferramentas do novo-qa.` : '';
      if (ask.length) {
        set('WAITING', [tail.result?.text, `Precisa da sua permissão para: ${ask.map((d) => d.rule).join(', ')}`, note].filter(Boolean).join('\n\n'), null);
        this.push(m.id, 'esperando sua permissão');
        return;
      }
      const n = (this.autoResumes.get(m.id) ?? 0) + 1;
      this.autoResumes.set(m.id, n);
      if (n <= MAX_AUTO_RESUME) {
        set('RUNNING', null, null);
        this.push(m.id, `bloqueado pelo NOVO QA: ${blocked.join(', ')} — seguindo com o aviso`);
        this.turn(m.id, note, current.session_id ?? undefined);
        return;
      }
      set('WAITING', `O agente insistiu em ações proibidas pelo NOVO QA (${blocked.join(', ')}). Oriente o próximo passo ou pare a missão.`, null);
      this.push(m.id, 'esperando você');
      return;
    }

    if (tail.result && !tail.result.error) {
      this.autoResumes.delete(m.id);
      const status: MissionStatus = this.runCompleted(m.id) ? 'DONE' : 'WAITING';
      set(status, tail.result.text || null, null);
      this.push(m.id, status === 'DONE' ? 'missão concluída' : 'esperando você');
      return;
    }
    const errFile = tail.path.replace(/\.jsonl$/, '.err');
    const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8').trim().slice(-1000) : '';
    const error = (tail.result?.text || stderr || 'o agente terminou sem resposta').slice(0, 1000);
    set('FAILED', tail.result?.text ?? (tail.lastText || null), error);
    this.push(m.id, `falhou: ${error.slice(0, 150)}`);
  }

  private runCompleted(id: string): boolean {
    this.link();
    const m = this.get(id);
    const run = m.run_id ? this.deps.db.prepare('SELECT status FROM runs WHERE id = ?').get(m.run_id) as { status: string } | undefined : undefined;
    return run?.status === 'COMPLETED';
  }

  private push(id: string, text: string, ts = this.ts()): void {
    const list = this.activity.get(id) ?? [];
    list.push({ ts, text });
    this.activity.set(id, list.slice(-60));
  }

  private addMessage(missionId: string, role: 'user' | 'agent' | 'system', text: string, ts = this.ts()): void {
    try {
      this.deps.db.prepare(`CREATE TABLE IF NOT EXISTS mission_messages (
        id INTEGER PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
        role TEXT NOT NULL CHECK (role IN ('user','agent','system')), text TEXT NOT NULL, ts TEXT NOT NULL
      )`).run();
      this.deps.db.prepare('INSERT INTO mission_messages (mission_id, role, text, ts) VALUES (?, ?, ?, ?)').run(missionId, role, text, ts);
    } catch {
      // Ignora silenciosamente se o schema ainda não estiver pronto
    }
  }

  private ts(): string {
    return this.now().toISOString();
  }
}

const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };

/** Pedido do Antigravity em uma linha: a regra negada e, se for ferramenta do novo-qa, o que ela faria. */
function describeRule(rule: string, detail: string): string {
  const mcp = /^mcp\(([^/]+)\/(.+)\)$/.exec(rule);
  const params = safeJson(detail) as { Arguments?: Record<string, unknown> } | string;
  if (mcp) return describeTool(`mcp__${mcp[1]}__${mcp[2]}`, (typeof params === 'object' && params?.Arguments) || {});
  const file = /^(write_file|replace_file_content|multi_replace_file_content|sed_file)\((.*)\)$/.exec(rule);
  if (file) return `Criar/editar arquivo ${file[2]}`;
  return `Usar ${rule}`;
}

/**
 * O Claude em modo print informa o uso do plano a cada resposta (rate_limit_event: fração usada e
 * reset por janela). Grava no mesmo arquivo da linha de status, que o medidor do painel lê.
 */
function writeLimits(file: string, windows: Windows | undefined): void {
  const pick = (w?: { utilization?: number; resetsAt?: number }) =>
    typeof w?.utilization === 'number' && typeof w.resetsAt === 'number' ? { used_percentage: Math.round(w.utilization * 1000) / 10, resets_at: w.resetsAt } : undefined;
  const five = pick(windows?.five_hour), week = pick(windows?.seven_day);
  if (!five && !week) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ five_hour: five, seven_day: week, updatedAt: new Date().toISOString() }));
    renameSync(`${file}.tmp`, file);
  } catch { /* o medidor é acessório: não derruba a missão */ }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Para o agente e o que ele abriu (servidor MCP, navegador): no Windows, a árvore inteira. */
function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* já saiu */ } }
}
