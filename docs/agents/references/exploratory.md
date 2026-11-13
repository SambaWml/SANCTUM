# Teste exploratório no Sanctum

Exploração é aprender, desenhar e executar ao mesmo tempo — mas com foco, tempo e registro. A unidade é a **sessão (charter)**, executada pelo papel **explorador** (`roles/explorer.md`). O Sanctum confere: o plano não aceita CT "exploratório" com roteiro, o `scenario_add` só aceita comportamento novo com origem, e o `run_complete` conta sessões fechadas.

## Modo descoberta (antes do plano, em missão exploratória)
Chegar num sistema sem saber nada não é sair clicando: é mapear, supor, perguntar e só então explorar. O `plan_save` de missão exploratória exige o mapa do projeto e nenhuma pergunta em aberto.

1. **Mapear só olhando.** `browser_open` abre para leitura antes do plano; o guard recusa o que cria, altera ou é de risco (nem `act_approved` vale). Em largura: menus e telas principais primeiro, teto de ~30 min. `system_map_save` grava `knowledge/<projeto>/mapa.yaml`: por tela, rota, nome, o que mostra, ações (com risco), APIs e acesso por papel (`ok`/`blocked`; o que não viu fica `unknown`). O que viu e não abriu vai em `unvisited`. O mapa descreve o que foi **visto**; não é regra.
2. **Hipóteses.** "Parece que consulta passa por agendada → confirmada" vai para `knowledge_propose` como OBSERVED/INFERRED, com a confiança. Nunca business_rule.
3. **Perguntas.** O que não dá para deduzir → `question_ask`. Mostre ao usuário e pare. `question_answer` registra a resposta dele (answer + a regra em uma frase; ele confirma a chamada) e ela vira regra com fonte "usuário". Não sabe → `dismiss` com o motivo.
4. **Charters por risco.** Com o mapa e as respostas, planeje as sessões onde o risco é maior (dinheiro, permissão, dado de outro usuário, ações RED do mapa).
5. **Memória.** O próximo `context_build` do projeto traz `systemMap` (índice; o detalhe de uma tela está no arquivo), `knowledge.unreviewed` (aprendido e ainda não revisado) e as perguntas pendentes. Ao revisitar uma tela, atualize o mapa: tela não vista há mais de 30 dias aparece marcada.

## Charter
| Campo | O que é |
|---|---|
| `target` | Tela, fluxo ou risco (ex.: "Checkout: pagamento recusado e volta") |
| `tours` | Testes a aplicar (lista abaixo, conforme o ambiente) |
| `persona` | Quem está usando (aluno novo sem histórico, admin apressado…) |
| `timeboxMin` | Tempo da sessão, padrão 45 min |
| `origin` | De onde veio o foco: lacuna/risco da análise da US, risco do módulo, bug antigo |

**Onde nasce:** no plano (`plan_save` → `charters`, aprovado pelo usuário) ou na execução (`charter_start` com target e tours), quando algo foge do esperado e merece uma sessão. O foco sai do que já se sabe: `batch_brief` → `exploration.seeds` (lacunas e riscos da análise) e `knownBugs` (bugs ligados).

## Ciclo da sessão
1. `charter_start(runId, code)` (planejado) ou com `target`/`tours` (novo). Uma por vez.
2. Explore no foco. Comportamento **novo** → `scenario_add` (vira EXP ligado à sessão), execute com `scenario_start` → `verify` → `scenario_complete`.
3. No prazo: `charter_end` com `covered` (telas, rotas e estados percorridos), `tours` (o que aplicou de fato), `observations` (usabilidade/layout/texto), `questions` (dúvidas para o PO), `notes` (o que ficou de fora). O Sanctum avisa nas respostas de `act`/`verify` quando a sessão passa do prazo.
4. Planejado que não deu para fazer: `charter_end` com `skipReason`.

**A sessão só fecha com substância** (o Sanctum recusa e diz o que falta):
- ao menos 10 min **explorando** e 15 ações/navegações: só conta o tempo entre ações, verificações e prints, e um intervalo parado acima de 3 min conta como 3. Não agende espera para cumprir o mínimo;
- ao menos 2 testes de tipos diferentes com rastro (erro/lentidão com `network_simulate`, celular com `browser_viewport`, `console`/`network`, outro papel, IDs/rotas trocados na URL). Só olhar a tela e mapear não é explorar;
- uma evidência: `screenshot` do que percorreu ou um achado (`scenario_add`);
- rastro de cada teste declarado em `tours`: disse que simulou erro de rede → chamou `network_simulate`; disse celular → `browser_viewport`; disse console/rede → `console` ou `network`; disse outro papel → `browser_open` com outro papel. Declare só o que aplicou.

Não dá para continuar (ambiente caiu, área inacessível): `charter_end` com `shortReason`. A sessão fica no relatório, mas não conta como exploração feita.

## Testes (tours)
O `batch_brief` → `exploration.tours.allowed` diz o que vale **neste ambiente**.

Sempre (não criam nem alteram dados):
- estados vazio, carregando e de erro com `network_simulate` (500, atraso de 4 s, lista vazia) — funciona dentro da sessão, sem cenário; acaba ao iniciar um cenário ou fechar a sessão;
- rotas e IDs trocados na URL (vaza dado de outro registro/usuário? valida permissão?);
- outro papel de usuário na mesma tela;
- voltar, recarregar e link direto no meio do fluxo;
- telas vizinhas que mostram o mesmo dado (contadores, listas, relatórios batem?);
- celular e tablet (`browser_viewport`);
- console e rede: 4xx/5xx silenciosos com a tela dizendo "sucesso".

Só com criação de dados liberada e fora de produção: campos no limite (texto longo, emoji, aspas, `<script>`, negativo, zero, número enorme, datas extremas), duplo envio, salvar + recarregar, pular etapas de formulário.

## O que é EXP e o que não é
| É EXP | Não é EXP (o Sanctum recusa e diz onde vai) |
|---|---|
| Comportamento novo achado explorando, com passos e esperado verificável | Lote/área a explorar → charter |
| Nasce de um cenário (`parentCode`) ou da sessão aberta | Reteste de bug → regressão no plano ou o fluxo retest |
| | Limpeza → `cleanup_run`/`data_register` · Evidência → `bug_evidence` |
| | Igual a bug já conhecido → cite a chave nas notes |

## Classificação
- **PRODUCT_BUG**: só se reproduzir (mesma verificação reprovada de novo). Visto uma vez ou intermitente → NEEDS_REVIEW com "X de Y".
- **OBSERVATION**: usabilidade, layout, texto, melhoria — com NEEDS_REVIEW ou PASSED. Nunca bug, não segura a recomendação. Pequena demais para um EXP → vai em `observations` do `charter_end`.
- **REQUIREMENT_AMBIGUITY**: falta regra para dizer o que é certo → pergunta ao PO.
- Erro de console sozinho é observação.

## Resultado
O relatório mostra cada sessão: o que foi percorrido, testes, tempo, achados, observações, perguntas e ideias não exploradas. Missão sem card não aprova nem reprova: o fechamento diz o que a exploração achou.
