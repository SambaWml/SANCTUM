# Execução, limpeza, aprendizado e fechamento

Vale para /qa, /qa-resume e /retest, com o plano já aprovado (run EXECUTING).

## Execução em lotes
Repita até `batch_brief` voltar vazio:
1. `batch_brief(runId)`.
2. Delegue o lote ao subagente `test-executor` com: `runId`, os códigos do lote e qualquer orientação que só você tem (ex.: "dev pediu para abrir pelo card do professor na barra lateral"). Não copie o briefing: ele chama `batch_brief`. Cenário com `resume` no briefing continua de onde parou.
3. Leia o resumo devolvido. Anomalia sem explicação → decida se vira exploratório (`scenario_add`) no próximo lote. Pedido de aprovação RED → pergunte ao usuário antes de mandar seguir.

Com `--explore`, reserve um lote para exploração dirigida pelos riscos mais altos.

## Limpeza
`cleanup_run(runId)`. Itens `unregistered` → `data_register` (api/manual com `verify`, ou `keep` com motivo). Repita até tudo VERIFIED ou KEPT.

## Aprendizado
`knowledge_propose` só com o que vale para o próximo card do módulo: regras com fonte documental, comportamentos observados (OBSERVED), riscos, regressões. Bug nunca vira regra.

## Fechamento
Recomendação: REPROVADO se houver PRODUCT_BUG em P0/P1 ou critério de aceite violado; INCONCLUSIVO se P0/P1 BLOCKED/NEEDS_REVIEW; senão APROVADO. O `run_complete` recusa recomendação acima do teto calculado pelos cenários (e reclassificar depois de concluído rebaixa a recomendação, se preciso). `run_complete(runId, recommendation, summary)` → `report_build(runId, explanations, summaries)`:
- `explanations`: um item por problema (FAILED e divergências relevantes) em linguagem simples para quem não acompanhou: passo a passo numerado para ver, o que acontece (com números e o que a API devolve), o que o card pede e ressalvas (ex.: verificação reprovada que foi erro de automação, dúvida para o PO); `severity` e, se virou card, `jira`.
- `summaries` (obrigatório, **todos** os cenários, inclusive os que passaram): veredito, o que foi visto em linguagem de quem não conhece o sistema, para onde olhar; `severity` nos achados (alta/media/baixa/nao-bug) e `jira` quando houver card. O HTML monta com isso o bloco "Em palavras simples", o filtro de severidade e o selo "Bug criado". Se `missingSummaries` voltar com códigos, complete antes de mostrar o relatório.
- Card de bug criado ou achado reclassificado depois: chame `report_build` de novo com `summaries` só dos códigos que mudaram (somam por código).

Mostre o resumo, os caminhos do relatório (`.md` e `.html`) e as dúvidas para o PO, e abra o HTML no navegador do usuário (Windows: `start "" "<caminho do .html>"`; macOS: `open`; Linux: `xdg-open`). Comentar no Jira só se o usuário pedir (o rascunho está no relatório).
