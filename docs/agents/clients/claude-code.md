# Cliente: Claude Code

O que difere do roteiro neutro quando o agente é o Claude Code. O roteiro é o de `docs/agents/`.

- **Fluxos são comandos:** `/qa`, `/qa-resume`, `/retest`, `/automate`, `/analisar` (skills em `.claude/skills/`, adaptadores que apontam para `docs/agents/<fluxo>.md`). `$ARGUMENTS` é o texto depois do comando. O `/resume` nativo retoma conversas, não runs: retomada de run é `/qa-resume`.
- **Ferramentas:** prefixo `mcp__sanctum__<nome>`; Jira pelo MCP Atlassian (`mcp__atlassian__getJiraIssue`…) ou pelo `getJiraIssue` do `sanctum`.
- **Papéis viram subagentes:** `test-executor` (executor de lote) e `test-explorer` (sessão exploratória), definidos em `.claude/agents/` e apontando para `docs/agents/roles/`. Passe `runId` e os códigos (ou o charter); eles chamam `batch_brief`. Um por vez; não opere navegadores concorrentes. O engenheiro de automação é um subagente `general-purpose` com o prompt "Siga `docs/agents/roles/engineer.md` para o card <card> (spec em <dir>, testes em <testsDir>)".
- **Aprovação:** as ferramentas sensíveis estão em `ask` no `.claude/settings.json`; o Claude Code mostra o prompt de permissão e o usuário confirma. Em missão lançada pelo painel, o prompt vai para o painel (`permission_prompt`).
- **Proteções do cliente:** `deny` para `Read(.env)`, `Read(.env.local)` e `Read(.auth/**)`; hook `PreToolUse` (`.claude/hooks/guard-shell.mjs`) bloqueia Bash/PowerShell operando navegador ou DELETE direto. Em missão do painel, `ScheduleWakeup` e `CronCreate` são negados.
- **Abrir arquivo para o usuário** (relatório HTML, pasta de evidência): Windows `start "" "<caminho>"`; macOS `open`; Linux `xdg-open`.
