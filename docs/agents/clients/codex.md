# Cliente: Codex (local)

O que difere do roteiro neutro quando o agente é o Codex local (CLI/IDE compatível). O roteiro é o de `docs/agents/`. Os arquivos `.claude/`, `CLAUDE.md` e `.mcp.json` continuam atendendo o Claude e não mudam.

## Ativação
1. Abra o Codex na raiz do repositório. Configuração em `.codex/config.toml` (o `cwd` do servidor está fixo para esta instalação; ajuste esse campo e o caminho em `.codex/hooks.json` se mover ou clonar o projeto).
2. Confie no projeto e autorize o hook local quando o cliente pedir.
3. Reinicie a sessão para carregar o MCP e as skills de `.agents/skills/`. `codex mcp get sanctum` deve mostrar o servidor habilitado com `SANCTUM_CLIENT=codex`.
4. Jira/Confluence: `codex mcp login atlassian` (OAuth próprio; não copie tokens do Claude).
5. Confira que `sanctum` oferece `run_status`, `plan_save`, `plan_approve`, `browser_open`, `act`, `act_approved`, `verify` e `report_build`.

## Diferenças
- **Fluxos:** em linguagem natural ("teste o card PROJ-123") ou pela skill (`$qa PROJ-123`, `$qa-resume`, `$retest`, `$automate`, `$analisar`). As skills em `.agents/skills/` apontam para `docs/agents/<fluxo>.md`; o card e as opções vêm do pedido do usuário.
- **Ferramentas:** descubra pelo servidor e pelo nome da operação; os prefixos variam entre clientes. Integração ausente é relatada antes de começar, nunca simulada.
- **Sem subagente garantido:** se houver delegação disponível e autorizada, use um executor ou explorador por vez com `roles/*.md`, `runId` e códigos; senão execute você mesmo, chamando `batch_brief` a cada lote. Automação: sem contexto novo, prepare o spec e peça uma nova sessão com o card e os caminhos; não declare validação independente na mesma conversa.
- **Aprovação:** as seis ferramentas sensíveis têm `approval_mode = "prompt"` em `.codex/config.toml`, e o servidor iniciado com `SANCTUM_CLIENT=codex` ainda pede confirmação humana por MCP elicitation antes de executá-las. Cancelar, recusar ou não oferecer o recurso bloqueia a operação; a confirmação nunca é um booleano passado pelo agente.
- **Hook:** `.codex/hooks/guard-shell.mjs` reutiliza o bloqueio de shell do Claude. Hooks locais exigem suporte e confiança do cliente; clientes com orquestração cloud podem não carregar hooks nem o MCP stdio local — use um Codex local compatível.
- **Métricas:** `SANCTUM_CLIENT=codex` desliga a ingestão de transcripts do Claude; tokens/custos do Codex não são contabilizados.
- **Tempo limite:** `tool_timeout_sec` precisa cobrir `automation_run` (até 10 min) mais a confirmação humana.

## Referências
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) · [MCP e políticas por ferramenta](https://learn.chatgpt.com/docs/extend/mcp) · [Hooks](https://learn.chatgpt.com/docs/hooks) · [Configuração](https://learn.chatgpt.com/docs/config-file/config-advanced)
