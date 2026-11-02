# Análise de qualidade de QA e consumo de tokens

Data: 01/11/2026. Escopo: análise estática do código e dos fluxos locais, com exemplos dos relatórios GURUJA-9233 e GURUJA-8241 e da execução acompanhada nesta conversa. Não é uma auditoria completa de todos os módulos nem uma nova execução dos cards.

## Diagnóstico

A base já protege aspectos importantes: verificação executada para PASSED, evidência para FAILED, Action Guard, redação de segredos, fonte documental para conhecimento, estado persistido e execução de testes da infraestrutura com fixture.

O maior ganho está em evitar decisões e navegações repetidas. Reduzir a quantidade de testes sem resolver a identidade dos cenários, a medição visual e a preparação de massa pode apenas produzir resultados mais baratos e menos confiáveis.

Parte do desperdício observado foi de condução: interpretar exemplos como pré-condições obrigatórias, assumir uma cor de borda como falha visual relevante, demorar a preparar massa pela UI, repetir seletores incorretos e reutilizar o mesmo código para testar outro comportamento. Esses pontos precisam ser tratados nas skills e nos contratos das ferramentas.

## Prioridade 1 — Resultado correto e reproduzível

### 1. Identidade estável e versão dos cenários

**Evidência:** `src/reporting/report.ts` associa aprovação em reteste pelo código do cenário; `src/mcp/tools/qa.ts` orienta reutilizar códigos. Nesta execução, CT-006 significou tooltip da linha e depois botão de informação, comportamentos diferentes. Foi adicionada proteção para reclassificação posterior, mas isso não resolve toda a identidade semântica.

**Proposta:** separar `scenarioId` estável do código exibido, adicionar `requirementId`, revisão do critério, alvo/interação e `retestOf`. Se o alvo ou o comportamento muda, registrar novo cenário relacionado, sem resolver automaticamente o anterior. Mudanças legítimas de critério devem ter revisão explícita, não apenas comparação textual do título.

**Aceite:** testar o botão de informação nunca resolve o tooltip da linha; repetir o mesmo comportamento em build novo pode resolver; revisão posterior mantém precedência e histórico.

### 2. Resultado atual calculado separadamente do fechamento histórico

**Evidência:** `StateStore.completeRun` recebe e grava a recomendação informada. `reclassifyScenario` altera resultados sem atualizar a recomendação. `buildReport` usa resultados ajustados por reteste e também a recomendação histórica de `run.recommendation`.

**Proposta:** uma função de avaliação compartilhada calcula o resultado atual a partir dos critérios obrigatórios, falhas, pendências e decisões aceitas. Preservar explicitamente o resultado no fechamento como histórico. Não converter uma decisão de aceitação em PASSED sem teste: usar uma resolução de achado como “não é bug” ou “aceito pelo responsável”, separada do resultado executado.

**Aceite:** o HTML não pode mostrar simultaneamente “nenhum bug ou pendência vigente” e “REPROVADO” sem identificar claramente que se trata de um resultado histórico. O escopo de um reteste pontual não aprova o card inteiro.

### 3. Cobertura por critério e distinção entre erro do teste e falha do produto

**Evidência:** `src/state/rules.ts` exige ao menos uma verificação para PASSED e resolve tentativas pela combinação `kind + description`. `BrowserService.checkUi` pode retornar falso para um alvo ausente ou ambíguo. Uma verificação positiva isolada não garante cobertura de todas as condições descritas no cenário.

**Proposta:** vincular cada checagem obrigatória a um `checkId` e critério. Registrar resultados como aprovação, falha da asserção, erro de execução e não avaliado. Seletores ambíguos devem produzir erro de execução com candidatos, e não evidência suficiente de defeito. Repetições devem usar IDs, não depender de repetir exatamente uma frase.

**Aceite:** aprovação de “modal abriu” não aprova cores, persistência ou compactação; erro de seletor não vira bug de produto; corrigir o seletor preserva histórico sem exigir repetição artificial de descrições.

### 4. Medição visual no próprio NOVO QA

**Evidência:** `src/browser/service.ts` permite verificar texto, estado e atributos, mas não altura renderizada, estilos computados ou truncamento geométrico. No GURUJA-9233, foi necessário analisar pixels da captura posteriormente.

**Proposta:** adicionar operações restritas de inspeção/verificação para retângulo renderizado, altura/largura, cores computadas, `scrollWidth/clientWidth`, sobreposição e quantidade visível. Retornar medidas, viewport, zoom/escala, alvo e evidência. Incluir tolerância e fonte do esperado. Não expor JavaScript arbitrário ao agente.

**Aceite:** conferir a altura de uma linha e o truncamento em uma chamada registrada, distinguindo pixels CSS de pixels da imagem. Classe `h-[62px]` não é tratada como medição de layout.

### 5. Decisões e massa como dados estruturados

**Evidência:** ajustes do usuário ficaram distribuídos na conversa e em textos longos de pré-condições. No GURUJA-9233, preparar massa pela modal resolveu bloqueios de três telas. A detecção automática em `BrowserService.act` procura POST 2xx; alterações por PUT precisaram de registro manual.

**Proposta:** antes do plano, distinguir requisito obrigatório, exemplo, valor pendente e premissa; cadastrar alterações com fonte e revisão. Manter catálogo de contas/massas por capacidade, sem segredos: meta longa, reforços, aprofundamentos, desempenho editável, questões propostas sem resolução. Registrar também mutações PUT/PATCH, com estado anterior, finalidade e política de restauração ou manutenção autorizada.

**Aceite:** “21 atividades é exemplo” aparece como decisão no briefing de qualquer executor; não é redescoberto. A mesma massa persistida serve para Meta, Arquivo e Desempenho sem recriação. Nenhuma alteração de progresso fica invisível ao relatório.

## Prioridade 2 — Reduzir contexto e chamadas

### 6. Um executor novo por lote e briefing menor

**Evidência:** a arquitetura pede contexto limpo por lote. Nesta conversa foram utilizados agentes com histórico completo e retomados por follow-up, carregando contexto anterior. `batch_brief` repete critérios, regras, papéis e pré-condições; `executionHints` devolve as primeiras 40 linhas, sem seleção por rota ou utilidade no lote.

**Proposta:** executor novo com contexto mínimo por lote, recebendo apenas runId, códigos e orientações adicionais ainda não persistidas. O briefing inclui critérios relevantes, decisões atuais, massa e seletores ordenados por rota, papel, sucesso recente e cenário. Colocar pré-condições compartilhadas no nível do lote. Evitar que o orquestrador e o executor leiam o mesmo briefing completo sem necessidade.

**Aceite:** medir bytes/tokens do briefing e do retorno por lote; o executor não recebe histórico de Jira, relatórios completos ou ações de outros módulos sem relação com o lote. A execução continua serial no navegador.

### 7. Operações curtas compostas, com guard por ação

**Evidência:** `BrowserService.act` captura snapshots antes/depois e aguarda a rede mesmo para cada preenchimento. Preparar uma atividade exigiu várias chamadas de campos, confirmação, salvar e verificar.

**Proposta:** `fill_form` para campos observados e `verify_many` para checagens independentes. Cada campo conserva alvo, redação, autorização e registro individuais; parar no primeiro erro. O submit deve ser uma ação explícita. Ações RED não entram em um lote silencioso nem herdam autorização do plano. No servidor, usar observação menor para preenchimentos que não mudam a estrutura, preservando detecção de validação/autosave.

**Aceite:** preencher seis campos não exige seis viagens completas ao modelo. O teste ainda identifica qual campo falhou e registra requisições disparadas por autosave.

### 8. Respostas projetadas e conhecimento realmente validado

**Evidência:** `network` corta corpos em 4000 caracteres; o observador guarda no máximo 20000. Isso impediu preservar contratos para simulação. `validatedActions` considera uma ação validada quando existe qualquer verificação positiva posterior no mesmo cenário; a relação com o resultado da ação não é explícita.

**Proposta:** consultas de JSON por campos/caminhos permitidos e paginação por entidade, sempre sanitizadas, com indicador de truncamento e referência ao arquivo de evidência. Disponibilizar resumo do contrato sem despejar corpo inteiro no contexto. Vincular ações aprendidas às checagens que confirmam seu efeito e à tentativa atual; ranquear seletores estáveis e depreciar os que falham.

**Aceite:** buscar contagens de uma atividade não exige reler uma resposta de milhares de caracteres. Uma ação seguida de uma verificação não relacionada não ganha automaticamente o selo de validada.

### 9. Relatórios completos uma vez, atualizações por diferença

**Evidência:** `report_build` recebe novamente textos longos de explicação; resumos já somam por código, mas as explicações usam o último conjunto inteiro. `missingSummaries` é retornado, sem impedir a entrega de relatório incompleto. O relatório GURUJA-8241 consultado tinha títulos com caracteres substituídos por `?` e não apresentava o bloco simples de todos os cenários.

**Proposta:** atualizar explicações por código como já acontece com resumos; gerar automaticamente fatos estruturados e pedir ao modelo apenas interpretação curta. Validar resumos, links de evidências, codificação e consistência antes da entrega. Trocar o rótulo automático “corrigido” por “passou no reteste”, a menos que exista evidência de correção de código.

**Aceite:** acrescentar um link de sub-bug não exige reenviar descrições de todos os achados. Relatório final não é entregue com resumos obrigatórios ausentes ou texto corrompido.

## Prioridade 3 — Medir e controlar a economia

### 10. Atribuição confiável de uso, tempo e chamadas

**Evidência:** `src/metrics/run-metrics.ts` associa uso por janela de tempo e sessões que chamaram novo-qa; o filtro de ferramentas contém um prefixo específico. Cache hit/miss também é contado pela janela, sem runId nessa consulta. `createRegistrar` associa a chamada ao run apenas quando `runId` está nos argumentos, deixando ações como `act`, `snapshot` e `verify` fora desse contador por run. A integração local declara que uso do Codex não é contabilizado; relatórios não devem apresentar tokens de outras sessões como custo do Codex.

**Proposta:** atribuição explícita por cliente, sessão, agente, run, cenário, tentativa e chamada. Resolver o run ativo no servidor para ferramentas de navegador. Normalizar nomes de ferramentas. Quando não houver uso disponível para o cliente, mostrar “não disponível”, não zero nem uma estimativa atribuída de outro cliente. Separar tempo ativo, aprovação humana, espera e pausa. Ingestão de transcripts deve ser incremental por arquivo/offset, em vez de reler todos os JSONL em cada relatório.

**Aceite:** dois cards intercalados não recebem as mesmas chamadas/tokens. Um cenário com 20 chamadas de navegador não aparece com poucas chamadas somente porque elas não levam runId. Agregar por cenário e por run deve reconciliar, com o restante identificado como descoberta/orquestração.

### 11. Controle de sessão e investigação proporcional

**Evidência:** há trava de navegador para recarga do supervisor, mas AGENTS.md explicita que não há exclusão mútua entre clientes. Durante esta execução, o navegador fechou inesperadamente; a causa não foi comprovada. Houve também repetição de consultas de status e atualizações com pouca informação nova.

**Proposta:** sessão com proprietário, runId, heartbeat e trava efetiva por workspace/ambiente. Retorno de progresso por evento reduz consultas repetidas. Definir orçamento de tentativas de seletor e investigação por cenário; esgotamento gera checkpoint e hipótese, sem converter automaticamente em falha. Manter atualizações úteis ao usuário sem reabrir decisões já autorizadas; preservam-se as aprovações obrigatórias do plano e de ações RED.

**Aceite:** um segundo cliente não fecha silenciosamente o navegador do primeiro; não há polling contínuo sem mudança; tentativas repetidas deixam razão e próximo passo concreto.

## Como medir o ganho sem prometer porcentagens sem base

1. Corrigir atribuição antes de comparar custos.
2. Usar uma amostra de cards: leitura, formulário com escrita, visual e integração, com risco comparável.
3. Medir tokens de entrada, cache e saída separadamente; chamadas por cenário; tempo ativo; reexecuções por erro do agente; bytes devolvidos por ferramenta; tamanho do briefing.
4. Medir qualidade junto: critérios obrigatórios realmente verificados, bugs confirmados depois pelo responsável, falsos bugs, pendências de massa e concordância entre conclusão e evidência.
5. Comparar medianas e cauda de custo/tempo, não apenas um caso favorável. Usar a mesma versão do sistema e massa equivalente quando comparar a infraestrutura.

Não existe uma porcentagem de economia comprovada por esta análise. As melhorias de contexto e operações compostas devem ser avaliadas contra esse baseline, sem reduzir verificações essenciais.

## Ordem de implementação sugerida

1. Identidade/revisão de cenário, resultado atual versus histórico e registro de decisões.
2. Métricas por sessão/run e medições visuais seguras.
3. Massa reutilizável, executor novo por lote e seleção relevante de conhecimento.
4. Formulários/verificações compostos e projeção de respostas.
5. Validação final de relatório, trava de sessão e comparação contínua dos indicadores.

Cada mudança deve passar por typecheck e testes pertinentes: sobretudo aprovação indevida por alvo diferente, reclassificação depois de reteste, erro de seletor, geometria com escala, atribuição de dois runs intercalados e preservação de guards em operações compostas.
