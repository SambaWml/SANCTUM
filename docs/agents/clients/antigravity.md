# Cliente: Antigravity

O que difere do roteiro neutro quando o agente é o Antigravity (lançado pelo painel com `agy -p`). O roteiro é o de `docs/agents/`.

- **Fluxos:** não há comando. A missão chega como "`/qa CARD`", "`/qa URL --explore`", "`/retest CARD`", "`/qa-resume CARD`", "`/analisar CARD`" ou "`/automate CARD`"; siga `docs/agents/<fluxo>.md` etapa por etapa, lendo as referências de cada etapa. As skills em `.agents/skills/` são o mesmo apontador.
- **Ferramentas:** `call_mcp_tool` com `ServerName: sanctum` e o nome da ferramenta. O `sanctum` já lê o Jira (`getJiraIssue`, `digest_get`/`digest_put`); não depende de MCP externo.
- **Sem subagente:** os papéis (`roles/executor.md`, `roles/explorer.md`) são executados por você, no mesmo ciclo, chamando `batch_brief` a cada lote. Automação: prepare o spec e peça ao usuário uma nova sessão para o engenheiro; não declare validação independente na mesma conversa.
- **Aprovação:** as ferramentas sensíveis não estão liberadas. Quando precisar de uma, chame-a normalmente: a negação vira um pedido no painel, o usuário decide e a missão continua com uma concessão única para aquela chamada. Não repita a chamada antes da resposta, não procure caminho alternativo.
- **Proibido, nunca liberado nem pelo painel:** `run_command` e qualquer terminal; o seu navegador próprio (`open_browser_url`, `browser_*`, `read_browser_page`, `capture_browser_*`); `schedule` (espera agendada); escrever nos arquivos do Sanctum (`src/`, `test/`, `.claude/`, `.codex/`, `.agents/`, `docs/agents/`, política).
- **Segredos:** não leia `.env` nem `.auth/` com `read_file`. Usuários de teste vêm de `environments` no `context_build`; a senha entra por `valueRef: "role:<papel>.password"`.
- **Sem terminal com o usuário:** quando precisar dele (aprovar o plano, escolher usuário, tirar dúvida), escreva a pergunta no fim da resposta e encerre o turno; a resposta chega na próxima mensagem. Não use ferramenta de pergunta ao usuário.
