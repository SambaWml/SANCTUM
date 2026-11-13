# Fluxo qa-resume — retomar um run interrompido

Argumentos: card ou runId. Fale com o usuário em português.

O estado está no SQLite, não no seu contexto: confie nas ferramentas, não em memória de conversa anterior.

1. `run_status(card)`. Sem run ou run já COMPLETED/ABORTED → diga isso e sugira o fluxo **qa** (novo) ou **retest** (após correção). Pare.
2. Mostre ao usuário o progresso (ex.: "19/32 concluídos; próximo: CT-020") e o que estava em andamento.
3. Conforme o status do run:
   - **PLANNING** — o plano não foi salvo. Retome `qa.md` a partir do planejamento (seções 1–3; o digest e o Context Package estão em cache). Não chame `run_start` de novo: o run já existe.
   - **AWAITING_APPROVAL** — `plan_view(card)`, reapresente o plano e espere aprovação explícita → `plan_approve`.
   - **EXECUTING** — o navegador pode ter sido fechado: o executor reabre (`browser_open`) e reaproveita a sessão salva do papel. Siga `references/execute-and-close.md`. Cenários concluídos não são reexecutados; o cenário interrompido vem com `resume` no briefing (o que já foi verificado).
4. Se o card mudou desde o plano (`getJiraIssue(fields=["updated"])` ≠ `digestVersion` do `context_build`), avise o usuário antes de continuar: pode valer abortar (`run_abort`) e replanejar.
