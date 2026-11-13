# Fluxo analisar — análise da US antes do teste

Argumentos: card. Fale com o usuário em português. Você lê, pensa e escreve; **não testa, não cria run, não abre o navegador e não publica nada no Jira**.

## 1. Ler o card (barato primeiro)
1. `getJiraIssue(card, fields=["updated"])` → `digest_get("jira", card, updated)`. Miss/stale: leia o card completo e grave com `digest_put` (mesmo schema do fluxo qa; critérios **literais**).
2. `context_build(card)`: conhecimento do módulo, histórico de runs, bugs ligados e, se houver, `systemMap` (o que já se sabe das telas). Se já houver `analysis`, diga quando foi feita e o que mudou.
3. Leia o que muda a análise: bugs ligados (regressão), subtarefas/pai, comentários com decisão, página Confluence citada, `knowledge/<projeto>/modules/*.yaml` do módulo. Figma é layout, não regra.
4. O "antes" da tela não faz parte desta análise: o navegador só abre dentro de um run. Se precisar ver a tela, isso é o fluxo qa.

## 2. Analisar
Para cada critério de aceite e regra:
- **Lacunas** (`gaps`): `ambiguidade` (dá para ler de dois jeitos), `lacuna` (estado/papel/limite/erro que o card não diz: vazio, carregando, sem permissão, máximo, concorrência, mobile), `contradicao` (critério × Figma × comentário × comportamento conhecido), `testabilidade` (não dá para verificar como está escrito).
- **Perguntas ao PO** (`questions`): uma por dúvida que muda o teste ou o código, curta, com opções quando houver (`options`). Prontas para colar.
- **Riscos** (`risks`): o que a mudança toca além da tela (telas vizinhas com o mesmo dado, API, outros papéis, relatórios) e bugs antigos que podem voltar (`regressionOf`).
- **Melhorias na funcionalidade** (`improvements`): o que deixaria a funcionalidade melhor para quem usa — fluxo mais curto, mensagem mais clara, consistência com telas vizinhas, acessibilidade, um fluxo novo que falta. Sempre com `why`. **É sugestão para o PO, nunca regra nem bug.**
- **Rascunho de cenários** (`draftScenarios`): no padrão de `references/plan-example.md` — pré-condição em todo cenário, esperado verificável, todo CA com cenário (cite `(CA03)`), negativo/permissão para risco HIGH, regressão dos bugs ligados. Use as lacunas para os negativos. Lacunas e riscos também viram o foco das sessões exploratórias (charters) do fluxo qa — o `batch_brief` os entrega ao explorador.

Não invente regra: o que não tem fonte vira pergunta, não esperado.

## 3. Gravar e mostrar
`us_analysis_save` com tudo acima, `sources` (o que foi lido) e `cardVersion` (o `updated`). Se voltar `draftProblems`, corrija o rascunho e grave de novo (o fluxo qa vai exigir o padrão no `plan_save`).

Mostre ao usuário, compacto: o resumo, as lacunas mais importantes, as perguntas ao PO, as melhorias sugeridas e a tabela do rascunho; mostre o caminho do HTML. Comentar no Jira só se o usuário pedir. Depois, o fluxo qa parte desta análise.
