# NOVO QA no Codex

Agente local de QA em português. O servidor MCP `novo-qa` fornece navegador,
estado, evidências e regras; o agente planeja e investiga. Leia `CLAUDE.md` para
as convenções do núcleo e a seção pertinente de `docs/ARCHITECTURE.md`.

## Integração e segurança

- Configuração do Codex: `.codex/config.toml`; skills: `.agents/skills/`.
  Preserve `.claude/`, `CLAUDE.md` e `.mcp.json`: continuam atendendo o Claude.
- Antes de QA, confirme que as ferramentas `novo-qa` estão disponíveis (o `novo-qa` integra
  leitura do Jira via `digest_get`, `getJiraIssue` e TWG local, ou Atlassian MCP).
  Se faltarem, explique a conexão necessária; não simule resultados nem opere
  o app por shell, browser externo, CUA, scripts ad-hoc ou outro MCP.
- Nunca declare PASSED sem verificação executada e registrada por `verify`.
- Senhas só pelo `.env`, `secret:NOME` ou `role:<papel>.password`; nunca no chat.
- Apresente o plano e aguarde aprovação explícita antes de `plan_approve`.
  `act_approved` exige autorização para a ação específica. A autorização do
  plano não autoriza automaticamente uma ação RED.
- As duas ferramentas sensíveis têm `approval_mode = "prompt"` no Codex.
  Não afrouxe essas configurações nem use uma chamada alternativa para evitá-las.
  O servidor também exige confirmação humana por MCP elicitation form quando
  iniciado com `NOVO_QA_CLIENT=codex`; falta de suporte ou recusa bloqueia a ação.
- O hook `.codex/hooks/guard-shell.mjs` reutiliza o bloqueio de shell do Claude.
  Não presuma que hooks locais estejam ativos em clientes com orquestração cloud.
  A obrigação de operar o app só pelo `novo-qa` vale em todos os clientes.
- Siga o roteiro da skill etapa por etapa. Não crie scripts nem arquivos avulsos
  (na raiz ou fora dela) para consultar o banco, o Jira ou montar relatórios: use
  `run_status`, `report_build`, `digest_*` e o Atlassian MCP.
- Bug que o usuário mandar abrir: `jira_create_issue` e, logo depois, `bug_evidence`
  para montar a pasta do bug (`runs/_evidencias/<card>-sub-bugs/<BUG> <título>/`).
  Roteiro em `.claude/skills/qa/references/execute-and-close.md` ("Bug no Jira").
- Não publique comentários no Jira sem pedido explícito. Observações não viram
  regras de negócio sem fonte documental.

## Fluxos

Use as skills locais `qa`, `qa-resume`, `retest` e `automate` para pedidos de QA,
retomada, reteste e automação. Elas referenciam os roteiros existentes e adaptam
a execução ao Codex. Em linguagem natural: "teste o card GURUJA-123".

Um agente opera este workspace por vez. Antes de trocar entre Claude e Codex,
feche o navegador/servidor anterior e consulte `run_status`; retome o estado
salvo, sem criar outro run para o mesmo trabalho. Banco, sessões, relatórios e
conhecimento são compartilhados. Não há exclusão mútua entre clientes garantida.

## Desenvolvimento

TypeScript ESM com imports `.ts`, execução por `tsx`. SQLite só por
`src/state/sqlite.ts`; saída do MCP sanitizada por `src/security/redact.ts`.
Valide mudanças de código com `npm run typecheck` e os testes pertinentes;
`npm test` executa a suíte completa com app fixture local.

No MCP iniciado pelo Codex, `NOVO_QA_CLIENT=codex` desabilita a ingestão de
transcripts do Claude. Tempo, chamadas de ferramentas e resultados continuam
disponíveis; tokens/custos do Codex ainda não são contabilizados.
