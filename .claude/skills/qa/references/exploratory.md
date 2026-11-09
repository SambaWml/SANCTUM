# Teste Exploratório no Sanctum (Mentalidade de Hacker & Caçador)

O teste exploratório combina aprendizado, desenho de teste e execução simultâneos. No Sanctum, ele não é um teste "ad-hoc sem rumo", mas uma expedição investigativa orientada a **charters** (missões) e **heurísticas**, executada pelo subagente `test-explorer`.

## Quando usar o `test-explorer`
1. **Missões de Reconhecimento (`explore` / URL sem card)**: A missão inteira é conduzida pelo `test-explorer`, com autonomia total de caça.
2. **Missões regulares com `--explore`**: Os lotes de maior risco e o lote exploratório são entregues ao `test-explorer` para testar os limites do módulo após a validação nominal dos CTs.
3. **Investigação de Anomalias Críticas**: Quando surge uma falha intermitente ou comportamento inexplicado que exige isolamento da causa raiz.

---

## Estrutura de um Charter de Exploração
Um charter define o foco da sessão sem engessar os passos:
- **Alvo**: A tela, funcionalidade ou fluxo sob teste.
- **Perspectiva / Persona**: Usuário caótico, usuário leigo, invasor de rotas ou integrador de API.
- **Heurística Central**: Limites de dados, quebra de concorrência, injeção de falhas com `network_simulate` ou manipulação de rotas.
- **Resultado Esperado**: O que seria considerado falha (erros silenciosos, dados perdidos, tela congelada, mutações inesperadas).

---

## Carta Branca para Desvio de Rota & Ataques
O explorador tem autorização explícita para:
1. **Incursão em Telas Vizinhas**: Sair da tela do card e verificar o reflexo das ações nos módulos dependentes (ex: cadastrou item na tela A, navega até a listagem/relatório na tela B).
2. **Manipulação de Parâmetros e URLs (`navigate`)**: Testar acesso direto a rotas profundas trocando IDs para verificar autorização de dados.
3. **Quebra de Sequência**: Pular etapas de wizards, avançar sem preencher campos prévios, recarregar durante submissões.

---

## Estrutura da Sessão em 3 Fases (Timebox)
1. **Fase 1: Reconhecimento de Superfície (20%)**: Mapear a tela, menus e rotas vizinhas via `snapshot`.
2. **Fase 2: Caos, Tensão & Injeção de Falhas (50%)**:
   - **Bordas & Limites**: Strings > 1000 chars sem espaços, emojis (`🔥🚀`), caracteres de escape (`'`, `"`, `\`, `<script>`), números negativos, zero e astronômicos.
   - **Concorrência**: Duplo clique rápido no botão de salvar/submeter para pegar *race conditions* e registros duplicados.
   - **Injeção de Falhas (`network_simulate`)**: Simular 500, delay de 4s ou retorno vazio `[]` na API para testar se a tela trata o erro com dignidade ou quebra.
   - **Responsividade (`browser_viewport`)**: Checar quebras de layout e botões inalcançáveis em modo mobile.
3. **Fase 3: Isolamento & Registro de Achados (30%)**:
   - Isolar o passo a passo mínimo das falhas encontradas.
   - Registrar no run via `scenario_add(runId, { title, type: 'exploratory', steps, ... })`.
   - Comprovar o erro com `verify` e `screenshot` na região do problema.

---

## Caça a Falhas Invisíveis
O usuário comum só vê o que renderiza na tela. O `test-explorer` investiga três camadas invisíveis:
- **`console`**: Exceções JavaScript não capturadas (`TypeError`, `Uncaught Promise`, `undefined`).
- **`network`**: Respostas HTTP 4xx e 5xx ignoradas pelo frontend.
- **`unexpectedMutation`**: Modificações de estado não autorizadas relatadas pelo Action Guard.

---

## Relatório de Retorno: "Troféus do Caçador"
O retorno da exploração sintetiza o valor gerado:
- **Território Coberto**: Rotas e telas vizinhas exploradas.
- **Troféus / Bugs Isolados**: Cenários criados dinamicamente via `scenario_add` e sua severidade — só conta como bug o que **reproduziu** (mesmos passos, falhou de novo); visto uma vez ou intermitente ("X de Y") fica como observação para o usuário decidir.
- **Falhas Técnicas Silenciosas**: Erros de console e requests 5xx identificados — observações, não bugs, salvo se reproduzirem com efeito para o usuário.
- **Novos Conhecimentos**: Comportamentos aprendidos sobre a robustez do sistema.
