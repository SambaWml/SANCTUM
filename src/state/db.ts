import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadSqlite } from './sqlite.ts';

export type Db = DatabaseSync;

/**
 * Migrações em ordem. Nunca edite uma migração já aplicada: acrescente outra.
 * A versão aplicada fica em PRAGMA user_version.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id                TEXT PRIMARY KEY,
    issue_key         TEXT NOT NULL,
    project           TEXT NOT NULL,
    env               TEXT NOT NULL,
    mode              TEXT NOT NULL CHECK (mode IN ('manual','explore','automate','retest')),
    parent_run_id     TEXT REFERENCES runs(id),
    status            TEXT NOT NULL CHECK (status IN ('PLANNING','AWAITING_APPROVAL','EXECUTING','COMPLETED','ABORTED')),
    plan_approved_at  TEXT,
    current_scenario  TEXT,
    recommendation    TEXT,
    summary           TEXT,
    started_at        TEXT NOT NULL,
    ended_at          TEXT
  );
  CREATE INDEX runs_issue ON runs(issue_key, started_at);

  CREATE TABLE scenarios (
    id                     INTEGER PRIMARY KEY,
    run_id                 TEXT NOT NULL REFERENCES runs(id),
    code                   TEXT NOT NULL,
    title                  TEXT NOT NULL,
    priority               TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
    types                  TEXT NOT NULL DEFAULT '[]',
    risk                   TEXT NOT NULL CHECK (risk IN ('HIGH','MEDIUM','LOW')),
    origin                 TEXT NOT NULL CHECK (origin IN ('planned','exploratory','retest')),
    parent_code            TEXT,
    preconditions          TEXT,
    steps                  TEXT NOT NULL DEFAULT '[]',
    expected               TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'PENDING',
    confidence             TEXT,
    confidence_score       REAL,
    classification         TEXT,
    observed               TEXT,
    reason                 TEXT,
    automation_suitability TEXT,
    automation_approved    INTEGER NOT NULL DEFAULT 0,
    seq                    INTEGER NOT NULL,
    started_at             TEXT,
    ended_at               TEXT,
    UNIQUE (run_id, code)
  );

  CREATE TABLE actions (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id),
    scenario_id  INTEGER REFERENCES scenarios(id),
    seq          INTEGER NOT NULL,
    action       TEXT NOT NULL,
    target_json  TEXT,
    value_ref    TEXT,
    guard_level  TEXT NOT NULL CHECK (guard_level IN ('GREEN','YELLOW','RED')),
    ok           INTEGER NOT NULL,
    error        TEXT,
    url          TEXT,
    duration_ms  INTEGER,
    ts           TEXT NOT NULL
  );

  CREATE TABLE evidence (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id),
    scenario_id  INTEGER REFERENCES scenarios(id),
    kind         TEXT NOT NULL,
    path         TEXT,
    sha256       TEXT,
    sanitized    INTEGER NOT NULL,
    meta         TEXT,
    ts           TEXT NOT NULL
  );

  CREATE TABLE verifications (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id),
    scenario_id  INTEGER NOT NULL REFERENCES scenarios(id),
    kind         TEXT NOT NULL CHECK (kind IN ('ui','url','network','api','persistence','console')),
    description  TEXT NOT NULL,
    expected     TEXT,
    actual       TEXT,
    passed       INTEGER NOT NULL,
    evidence_id  INTEGER REFERENCES evidence(id),
    ts           TEXT NOT NULL
  );

  CREATE TABLE findings (
    id              INTEGER PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id),
    scenario_id     INTEGER REFERENCES scenarios(id),
    classification  TEXT NOT NULL,
    severity        TEXT,
    title           TEXT NOT NULL,
    repro           TEXT,
    status          TEXT NOT NULL,
    jira_key        TEXT,
    ts              TEXT NOT NULL
  );

  CREATE TABLE created_data (
    id              INTEGER PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id),
    scenario_id     INTEGER REFERENCES scenarios(id),
    resource        TEXT NOT NULL,
    ext_id          TEXT,
    cleanup_json    TEXT,
    cleanup_status  TEXT NOT NULL DEFAULT 'PENDING',
    verified_at     TEXT,
    ts              TEXT NOT NULL
  );

  CREATE TABLE approvals (
    id        INTEGER PRIMARY KEY,
    run_id    TEXT NOT NULL REFERENCES runs(id),
    action    TEXT NOT NULL,
    target    TEXT,
    level     TEXT NOT NULL,
    decision  TEXT NOT NULL,
    ts        TEXT NOT NULL
  );

  CREATE TABLE events (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT,
    scenario_id  INTEGER,
    type         TEXT NOT NULL,
    payload      TEXT,
    ts           TEXT NOT NULL
  );
  CREATE INDEX events_scope ON events(run_id, scenario_id, type);

  CREATE TABLE model_usage (
    id           INTEGER PRIMARY KEY,
    session_id   TEXT NOT NULL,
    agent        TEXT,
    run_id       TEXT,
    scenario_id  INTEGER,
    input        INTEGER NOT NULL,
    output       INTEGER NOT NULL,
    cache_read   INTEGER NOT NULL DEFAULT 0,
    cache_write  INTEGER NOT NULL DEFAULT 0,
    ts           TEXT NOT NULL
  );

  CREATE TABLE cache_entries (
    source      TEXT NOT NULL,
    key         TEXT NOT NULL,
    version     TEXT NOT NULL,
    hash        TEXT,
    path        TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (source, key)
  );
  `,
  // 2: módulos de conhecimento do run (carregar/gravar execution knowledge do módulo certo).
  `ALTER TABLE runs ADD COLUMN modules TEXT NOT NULL DEFAULT '[]';`,
  // 3: uso de modelo vindo dos transcripts do Claude Code (uma linha por chamada ao modelo).
  `
  ALTER TABLE model_usage ADD COLUMN message_id TEXT;
  ALTER TABLE model_usage ADD COLUMN model TEXT;
  ALTER TABLE model_usage ADD COLUMN tools TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE model_usage ADD COLUMN sidechain INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX model_usage_message ON model_usage(message_id);
  CREATE INDEX model_usage_ts ON model_usage(session_id, ts);
  `,
  // 4: automação — amostra de valor literal (nunca segredo) e execuções da suíte gerada.
  `
  ALTER TABLE actions ADD COLUMN value_sample TEXT;
  ALTER TABLE verifications ADD COLUMN spec_json TEXT;
  CREATE TABLE automation_runs (
    id           INTEGER PRIMARY KEY,
    issue_key    TEXT NOT NULL,
    project      TEXT NOT NULL,
    run_id       TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('attempt','validation')),
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    total        INTEGER NOT NULL DEFAULT 0,
    passed       INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    flaky        INTEGER NOT NULL DEFAULT 0,
    skipped      INTEGER NOT NULL DEFAULT 0,
    exit_code    INTEGER,
    report_path  TEXT
  );
  CREATE TABLE automation_tests (
    id                 INTEGER PRIMARY KEY,
    automation_run_id  INTEGER NOT NULL REFERENCES automation_runs(id),
    file               TEXT NOT NULL,
    title              TEXT NOT NULL,
    scenario_code      TEXT,
    status             TEXT NOT NULL CHECK (status IN ('passed','failed','flaky','skipped')),
    attempts           INTEGER NOT NULL,
    duration_ms        INTEGER,
    error              TEXT
  );
  `,
  // 5: integridade (gatilhos no lugar de CHECK: SQLite não altera CHECK sem recriar a tabela)
  //    e o agente que operou o run e cada aprovação (JSON {client, version, model}).
  `
  CREATE TRIGGER scenarios_status_ins BEFORE INSERT ON scenarios
    WHEN NEW.status NOT IN ('PENDING','IN_PROGRESS','PASSED','FAILED','BLOCKED','NOT_EXECUTED','NEEDS_REVIEW')
    BEGIN SELECT RAISE(ABORT, 'status de cenário inválido'); END;
  CREATE TRIGGER scenarios_status_upd BEFORE UPDATE OF status ON scenarios
    WHEN NEW.status NOT IN ('PENDING','IN_PROGRESS','PASSED','FAILED','BLOCKED','NOT_EXECUTED','NEEDS_REVIEW')
    BEGIN SELECT RAISE(ABORT, 'status de cenário inválido'); END;
  CREATE TRIGGER scenarios_class_ins BEFORE INSERT ON scenarios
    WHEN NEW.classification IS NOT NULL AND NEW.classification NOT IN
      ('PRODUCT_BUG','AUTOMATION_FAILURE','ENVIRONMENT_FAILURE','TEST_DATA_FAILURE','REQUIREMENT_AMBIGUITY','EXPECTED_BEHAVIOR','UNKNOWN')
    BEGIN SELECT RAISE(ABORT, 'classificação inválida'); END;
  CREATE TRIGGER scenarios_class_upd BEFORE UPDATE OF classification ON scenarios
    WHEN NEW.classification IS NOT NULL AND NEW.classification NOT IN
      ('PRODUCT_BUG','AUTOMATION_FAILURE','ENVIRONMENT_FAILURE','TEST_DATA_FAILURE','REQUIREMENT_AMBIGUITY','EXPECTED_BEHAVIOR','UNKNOWN')
    BEGIN SELECT RAISE(ABORT, 'classificação inválida'); END;
  CREATE TRIGGER created_data_status_ins BEFORE INSERT ON created_data
    WHEN NEW.cleanup_status NOT IN ('UNREGISTERED','PENDING','VERIFIED','FAILED','KEPT')
    BEGIN SELECT RAISE(ABORT, 'cleanup_status inválido'); END;
  CREATE TRIGGER created_data_status_upd BEFORE UPDATE OF cleanup_status ON created_data
    WHEN NEW.cleanup_status NOT IN ('UNREGISTERED','PENDING','VERIFIED','FAILED','KEPT')
    BEGIN SELECT RAISE(ABORT, 'cleanup_status inválido'); END;
  ALTER TABLE runs ADD COLUMN agent TEXT;
  ALTER TABLE approvals ADD COLUMN agent TEXT;
  `,
  // 6: missões lançadas pelo painel ao vivo (agente em segundo plano) e os pedidos que esperam o
  //    usuário no painel (permissão de ferramenta, aprovação de plano já dada pelo botão).
  `
  CREATE TABLE missions (
    id            TEXT PRIMARY KEY,
    agent         TEXT NOT NULL,
    target        TEXT NOT NULL,
    kind          TEXT NOT NULL,
    objective     TEXT,
    status        TEXT NOT NULL CHECK (status IN ('RUNNING','WAITING','DONE','FAILED','STOPPED')),
    session_id    TEXT,
    pid           INTEGER,
    last_message  TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE TABLE prompts (
    id           INTEGER PRIMARY KEY,
    mission_id   TEXT NOT NULL REFERENCES missions(id),
    kind         TEXT NOT NULL CHECK (kind IN ('permission','plan')),
    tool         TEXT,
    summary      TEXT NOT NULL,
    input_json   TEXT,
    status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ANSWERED','USED','EXPIRED')),
    decision     TEXT CHECK (decision IN ('allow','deny')),
    message      TEXT,
    created_at   TEXT NOT NULL,
    answered_at  TEXT
  );
  CREATE INDEX prompts_pending ON prompts(status, mission_id);
  `,
  // 7: saída do turno em arquivo (o agente não morre se o painel for reiniciado).
  `ALTER TABLE missions ADD COLUMN log_path TEXT;`,
  // 8: run aberto pela missão (Antigravity não herda SANCTUM_MISSION: o MCP dele é do processo do app).
  `ALTER TABLE missions ADD COLUMN run_id TEXT;`,
  // 9: o que o usuário tirou do painel (missão excluída, run ocultado). Só some da tela: histórico e evidências ficam.
  `
  ALTER TABLE missions ADD COLUMN archived_at TEXT;
  CREATE TABLE hidden_runs (run_id TEXT PRIMARY KEY, hidden_at TEXT NOT NULL);
  `,
  // 10: histórico de mensagens da conversa direta com o agente na Central de Caça.
  `
  CREATE TABLE mission_messages (
    id          INTEGER PRIMARY KEY,
    mission_id  TEXT NOT NULL REFERENCES missions(id),
    role        TEXT NOT NULL CHECK (role IN ('user','agent','system')),
    text        TEXT NOT NULL,
    ts          TEXT NOT NULL
  );
  CREATE INDEX mission_messages_mid ON mission_messages(mission_id, id);
  `,
  // 11: análise da US antes do teste (/analisar): lacunas, perguntas ao PO, riscos, melhorias e
  //     rascunho de cenários; o /qa parte dela (context_build).
  `
  CREATE TABLE us_analyses (
    id           INTEGER PRIMARY KEY,
    issue_key    TEXT NOT NULL,
    card_version TEXT,
    agent        TEXT,
    payload      TEXT NOT NULL,
    report_path  TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX us_analyses_issue ON us_analyses(issue_key, created_at);
  `,
];

/**
 * Banco padrão: data/sanctum.db. Instalação de antes da troca de nome (data/novo-qa.db) é
 * renomeada na primeira abertura; se o arquivo antigo estiver em uso (outro processo aberto),
 * continua nele até a próxima vez.
 */
export function defaultDbPath(root: string): string {
  if (process.env.SANCTUM_DB) return process.env.SANCTUM_DB;
  const path = join(root, 'data', 'sanctum.db');
  const legacy = join(root, 'data', 'novo-qa.db');
  if (existsSync(path) || !existsSync(legacy)) return path;
  try {
    renameSync(legacy, path);
    for (const ext of ['-wal', '-shm']) if (existsSync(legacy + ext)) renameSync(legacy + ext, path + ext);
    return path;
  } catch {
    if (existsSync(path) && !existsSync(legacy)) return path;
    return legacy;
  }
}

export function openDb(path: string): Db {
  const { DatabaseSync } = loadSqlite();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
