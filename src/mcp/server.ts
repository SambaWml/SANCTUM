import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserService } from '../browser/service.ts';
import type { Config } from '../config/schema.ts';
import type { Redactor } from '../security/redact.ts';
import type { SecretStore } from '../security/secrets.ts';
import { DigestCache } from '../sources/digest.ts';
import type { Db } from '../state/db.ts';
import type { StateStore } from '../state/store.ts';
import { createRegistrar } from './tooling.ts';
import { registerAnalysisTools } from './tools/analysis.ts';
import { registerAutomationTools } from './tools/automation.ts';
import { registerBrowserTools } from './tools/browser.ts';
import { registerContextTools } from './tools/context.ts';
import { registerEnvTools } from './tools/env.ts';
import { registerJiraTools } from './tools/jira.ts';
import { registerQaTools } from './tools/qa.ts';
import { registerPermissionPrompt } from './tools/permission.ts';
import { registerStateTools } from './tools/state.ts';

export interface ServerDeps {
  store: StateStore;
  redactor: Redactor;
  rootDir: string;
  /** Com config e db, expõe contexto (digests, Context Package) e fluxo /qa (lotes, relatório, conhecimento). */
  config?: Config;
  db?: Db;
  /** Habilita config_reload. */
  secrets?: SecretStore;
  /** Sem navegador, as ferramentas de navegador não são expostas. */
  browser?: BrowserService;
  /** Pastas de transcript do Claude Code (métricas de tokens). */
  transcriptDirs?: string[];
  /** Codex: confirmação humana por elicitation, bloqueando clientes sem suporte. */
  requireHumanApproval?: boolean;
  /** Só para testes: baseUrl da suíte de automação (porta dinâmica do fixture). */
  automationBaseUrl?: string;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'sanctum', version: '0.1.0' });
  const tool = createRegistrar(server, {
    ...deps,
    currentRun: () => {
      const status = deps.browser?.status();
      return status?.open ? status.runId : null;
    },
  });
  const cache = deps.db ? new DigestCache(deps.db, deps.rootDir) : undefined;
  // Critérios de aceite e bugs ligados ao card (digest em cache), para o padrão de plano no plan_save.
  const cardOf = (issueKey: string): { criteria: string[]; linkedBugs: string[] } => {
    const hit = cache?.get('jira', issueKey, undefined, { internal: true });
    if (!hit?.hit) return { criteria: [], linkedBugs: [] };
    const d = hit.digest as { acceptanceCriteria?: string[]; links?: { key: string; relation: string; status?: string }[] };
    // Bug ligado (sub-bug, "is caused by bug"…) ainda aberto pede regressão; o já fechado também, se não houver status.
    const linkedBugs = (d.links ?? []).filter((l) => /bug|defeito/i.test(l.relation)).map((l) => l.key);
    return { criteria: d.acceptanceCriteria ?? [], linkedBugs: [...new Set(linkedBugs)] };
  };
  registerStateTools(tool, { ...deps, cardOf });
  if (deps.config && deps.db && cache) {
    const full = { ...deps, config: deps.config, db: deps.db, cache };
    registerContextTools(tool, full);
    registerQaTools(tool, full);
    registerJiraTools(tool, { db: deps.db, rootDir: deps.rootDir });
    registerEnvTools(tool, { rootDir: deps.rootDir });
    registerAnalysisTools(tool, { db: deps.db, rootDir: deps.rootDir, cardOf, agent: () => server.server.getClientVersion()?.name ?? null });
    registerAutomationTools(tool, full);
  }
  if (deps.browser) registerBrowserTools(tool, deps.browser, deps.store);
  if (deps.db) registerPermissionPrompt(server, { db: deps.db, redactor: deps.redactor, store: deps.store });
  return server;
}
