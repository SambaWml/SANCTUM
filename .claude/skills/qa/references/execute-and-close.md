# Execução, limpeza, aprendizado e fechamento

Vale para /qa, /qa-resume e /retest, com o plano já aprovado (run EXECUTING).

## Execução em lotes
Repita até `batch_brief` voltar vazio:
1. `batch_brief(runId)`.
2. Delegue o lote de acordo com o modo da missão:
   - **Missão de Reconhecimento / Exploratória (`explore` ou URL sem card)**: A expedição inteira é comandada pelo subagente `test-explorer` (veja `references/exploratory.md`). Ele tem carta branca para desvio de rota, ataques de caos, injeção de falhas com `network_simulate` e geração dinâmica de novos cenários via `scenario_add`.
   - **Missão Regular de Card (`qa` / `retest`)**:
     * Cenários funcionais regulares e de regressão: delegue ao subagente `test-executor` com `runId`, códigos e orientações específicas.
     * Com `--explore` ou cenários de risco exploratório (`EXP-*`): delegue a bateria exploratória ao subagente `test-explorer` para caça agressiva nas bordas e vulnerabilidades do sistema.
   Não copie o briefing: os subagentes chamam `batch_brief`. Cenário com `resume` no briefing continua de onde parou.
3. Leia o resumo devolvido. Anomalia sem explicação → decida se vira exploratório (`scenario_add`) no próximo lote. Pedido de aprovação RED → pergunte ao usuário antes de mandar seguir.

Padrão Sanctum: todo teste termina com exploração registrada — pelo menos 1 EXP executado em volta do risco maior (3 no exploratório), criados com `scenario_add` durante a execução (ver `references/plan-example.md`, seção EXP). Sem isso o `run_complete` pede `noExplorationReason`. Em missões com `--explore`, certifique-se de que o `test-explorer` explore profundamente as frestas, dados caóticos e falhas invisíveis de console/network antes de concluir.

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

## Bug no Jira (só quando o usuário pedir)
Para cada bug que o usuário mandar abrir:
1. Confira antes contra o card: o comportamento contraria um critério ou regra escrita? E a evidência mostra mesmo o defeito (meta/tela/usuário certos)? Se o print não mostra a parte do problema, veja o vídeo antes de afirmar.
2. `jira_create_issue` (tipo e pai que o usuário indicar; sub-bug com `parent`): título `[Tela] o que está errado (CA/RN)`; descrição com como ver (passo a passo, usuário de teste), o que acontece e o esperado pelo card. Sem citar a ferramenta de automação, sem trace.
3. Logo em seguida, `bug_evidence(runId, issueKey, title, codes, frames)`: monta `runs/_evidencias/<card>-sub-bugs/<BUG> <título>/` com prints, quadros do vídeo, trecho do vídeo com cursor, respostas de API e LEIA-ME. Em `frames`, o momento exato em que o defeito aparece em cada cenário (`offsetSec` desde o início do cenário no vídeo), com nome que diga o que mostra. Um bug por pasta; nunca trace.
4. `report_build` com `summaries`/`explanations` dos códigos com o `jira` novo, e mostre ao usuário os links dos cards e as pastas (abra a pasta no Explorer).

Durante a execução, prefira prints que mostrem o defeito (`screenshot` com `scope` na região ou página inteira), não só o topo da tela.
