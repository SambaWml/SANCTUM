---
name: automate
description: Gera e valida automação Playwright a partir de uma execução manual concluída do NOVO QA, usando os passos e verificações registrados.
---

# Automação pelo Codex

Leia [o adaptador do Codex](../../../docs/CODEX.md#execução-dos-fluxos)
e siga [o roteiro de automação](../../../.claude/skills/automate/SKILL.md).
Use o card ou runId do pedido no lugar de `$ARGUMENTS`.

Na etapa de implementação, leia
[as instruções do engenheiro](../../../.claude/skills/automate/references/engineer.md).
Execute testes pelo MCP `automation_run`, com o limite de tentativas e a
validação de estabilidade existentes. Não enfraqueça assertions para passar.
A adaptação de contexto novo/subagentes está em `docs/CODEX.md`.
