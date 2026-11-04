import { z } from 'zod';
import { buildContextPackage, renderContextPackage, type ContextDeps } from '../../context/package.ts';
import { autoSyncJiraCard, fetchJiraIssueViaTwg } from '../../sources/jira.ts';
import type { StateStore } from '../../state/store.ts';
import { ToolContent, type RegisterTool } from '../tooling.ts';

export function registerContextTools(tool: RegisterTool, deps: ContextDeps & { store: StateStore }): void {
  const { cache } = deps;
  const source = z.enum(['jira', 'confluence']);

  tool(
    'digest_get',
    'Digest em cache de um card Jira ou página Confluence. Passe version (o "updated" do Jira ou a versão da página, ' +
      'obtidos numa leitura barata) para só aceitar se a fonte não mudou. Miss/stale: leia a fonte e grave com digest_put.',
    { source, key: z.string(), version: z.string().optional(), runId: z.string().optional() },
    (a) => {
      const res = cache.get(a.source, a.key, a.version, { runId: a.runId });
      if (!res.hit && a.source === 'jira') {
        const synced = autoSyncJiraCard(a.key, cache);
        if (synced) return cache.get(a.source, a.key, a.version, { runId: a.runId });
      }
      return res;
    },
  );

  tool(
    'digest_put',
    'Grava o digest compacto de uma fonte lida pelo Atlassian MCP (schema fixo; critérios de aceite copiados literalmente; nunca senhas). ' +
      'jira: key,title,type,status,priority?,parent?,components,labels,summary,acceptanceCriteria,businessRules,roles,openQuestions,' +
      'links[{key,relation,title?,status?}],attachments[{name,kind,note?}],figma,confluence[{ref,title?}],comments,environmentHints. ' +
      'confluence: id,title,space?,summary,rules,permissions,flows,sections,related.',
    { source, key: z.string(), version: z.string().min(1), digest: z.record(z.string(), z.unknown()) },
    (a) => {
      const stored = cache.put(a.source, a.key, a.version, a.digest);
      return { stored: `${stored.source}:${stored.key}`, version: stored.version, hash: stored.hash };
    },
  );

  tool(
    'getJiraIssue',
    'Consulta dados de um card do Jira (via integração Atlassian / TWG do ambiente). Devolve issue com summary, description, status, etc.',
    {
      issueIdOrKey: z.string().describe('chave do card, ex.: GURUJA-9038'),
      fields: z.array(z.string()).optional(),
    },
    (a) => {
      const issue = fetchJiraIssueViaTwg(a.issueIdOrKey);
      if (issue) {
        autoSyncJiraCard(a.issueIdOrKey, cache);
        return issue;
      }
      const cached = cache.get('jira', a.issueIdOrKey);
      if (cached.hit) return cached.digest;
      return { error: `Card ${a.issueIdOrKey} não encontrado no Jira nem no cache local` };
    },
  );

  tool(
    'context_build',
    'Context Package do card (YAML compacto): issue, projeto, ambientes (e o que falta no .env), módulos de conhecimento que casam, ' +
      'referências ainda não lidas e histórico de runs. Exige o digest Jira do card em cache. ' +
      'Missão sem card (EXPLORA-AAAAMMDDHHmm): o digest é o objetivo da missão e project é obrigatório.',
    { issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/), project: z.string().optional().describe('só em missão sem card'), runId: z.string().optional() },
    (a) => {
      const { yaml, approxTokens } = renderContextPackage(buildContextPackage(deps, a.issueKey, { project: a.project }));
      deps.store.logEvent(a.runId ?? null, null, 'context.build', { issueKey: a.issueKey, approxTokens });
      // YAML puro: dentro de JSON as quebras de linha viram \n escapado (mais tokens, menos legível).
      return new ToolContent([{ type: 'text', text: `${yaml}# ~${approxTokens} tokens\n` }]);
    },
  );
}
