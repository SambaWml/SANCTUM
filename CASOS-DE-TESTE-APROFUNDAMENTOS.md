# 📚 Suíte Completa de Casos de Teste — Épico Aprofundamentos (GURUJA-9023)

> **Épico Jira:** [GURUJA-9023](https://luby.atlassian.net/browse/GURUJA-9023) — *APROFUNDAMENTOS | Aba e item de meta escolhido pelo aluno*  
> **Objetivo:** Fornecer autonomia ao aluno com o 3º tipo de item na meta (ao lado de Atividades e Reforços), permitindo estudos de ~30 min em disciplinas do planejamento.  
> **Compilação e Auditoria:** NOVO QA · Novembro/2026.

---

## 📑 Índice dos Cards do Épico

1. [GURUJA-9032 — Fase 1 · Tela de Meta (Lista, Adicionar, Registro e Limites)](#1-guruja-9032--fase-1--tela-de-meta)
2. [GURUJA-9036 — Fase 1 · Tela de Calendário (Faixa, Movimentação e Ciclo)](#2-guruja-9036--fase-1--tela-de-calendário)
3. [GURUJA-9038 — Fase 1 · Tela de Arquivo (Tabela, Histórico e Indicadores)](#3-guruja-9038--fase-1--tela-de-arquivo)
4. [GURUJA-9101 — Fase 1 · Tela de Padrão de Erros (Filtro Itens e Motivos de Questões)](#4-guruja-9101--fase-1--tela-de-padrão-de-erros)
5. [GURUJA-9169 — Fase 1 · Questões — Simulado por Disciplina](#5-guruja-9169--fase-1--questões--simulado-por-disciplina)
6. [GURUJA-9039 — Fase 2 (Antecipada) · Tela de Desempenho](#6-guruja-9039--fase-2-antecipada--tela-de-desempenho)
7. [GURUJA-9040 — Fase 2 (Antecipada) · Tela de Jornada](#7-guruja-9040--fase-2-antecipada--tela-de-jornada)

---

## 1. GURUJA-9032 — Fase 1 · Tela de Meta
*Link Jira:* [GURUJA-9032](https://luby.atlassian.net/browse/GURUJA-9032)  
*Escopo:* Criação, catálogo, vagas (teto 20), tipos (Questões, Teoria, Anotações, Lei Seca, Jurisprudência), assuntos cobertos, cópia TEC e registro de estudo.

### Critérios de Aceite (CAs)
* **CA01:** Aba Aprofundamentos na Lista da Meta com contador, tabela agrupada por disciplina, botão Adicionar e teto de vagas.
* **CA02:** Modal de Adicionar com fluxo em 3 passos: Disciplina -> Tipo -> Assunto(s) ou Simulado.
* **CA03:** Integração TEC (Questões): criação de cópia própria nomeada com o código do item (`RN05`).
* **CA04:** Assuntos cobertos: selecionar capítulo marca automaticamente todos os subassuntos (`RN77`).
* **CA05:** Teto de 20 pendentes: botão desabilita ao atingir limite (`RN21`).
* **CA06:** Registro de conclusão: Questões abre modal completa (questão a questão); demais tipos registram tempo (hh:mm).
* **CA07:** Remoção: apenas itens pendentes podem ser removidos; cumpridos não podem ser excluídos (`RN33`, `RN34`).

### Casos de Teste Detalhados

#### **CT-01: Exibição da aba Aprofundamentos e contador de vagas**
* **Pré-condições:** Aluno com meta ativa.
* **Passos:**
  1. Acessar a Tela de Meta (visão Lista).
  2. Localizar as abas principais: Atividades, Reforços e Aprofundamentos.
  3. Verificar o cabeçalho da aba Aprofundamentos e o saldo de vagas (`X de 20 vagas disponíveis`).
* **Resultado Esperado:** Aba visível, contador reflete o número real de pendentes e botão `+ Adicionar aprofundamento` habilitado.

#### **CT-02: Criação de Aprofundamento de Questões com Cópia TEC**
* **Pré-condições:** Aluno com vagas disponíveis e integração TEC ativa.
* **Passos:**
  1. Clicar em `+ Adicionar aprofundamento`.
  2. Selecionar uma disciplina e o tipo **Questões**.
  3. Selecionar a banca e um assunto com caderno disponível.
  4. Confirmar a criação.
* **Resultado Esperado:** Item criado na meta com código padrão `RN05` (ex: `DIRAD.ABC.1.Q001`), caderno gerado no TEC com nome idêntico ao código e vaga consumida.

#### **CT-03: Criação de Teoria/Lei Seca com múltiplos assuntos e capítulos (Assuntos Cobertos)**
* **Pré-condições:** Aluno na modal Adicionar.
* **Passos:**
  1. Selecionar tipo **Teoria** ou **Lei Seca**.
  2. Marcar um capítulo pai que contenha subassuntos.
  3. Observar a marcação dos descendentes.
  4. Confirmar a criação.
* **Resultado Esperado:** Todos os subassuntos são registrados como "cobertos" (`RN77`); detalhe exibe a árvore de assuntos e orientação personalizada das 3 principais cobranças da banca (`RN78`).

#### **CT-04: Bloqueio por Teto Máximo de 20 Pendentes**
* **Pré-condições:** Aluno com 20 aprofundamentos pendentes acumulados.
* **Passos:**
  1. Abrir a Tela de Meta.
  2. Observar o botão `+ Adicionar aprofundamento`.
  3. Tentar abrir a modal de criação.
* **Resultado Esperado:** Botão desabilitado com indicação `Limite atingido (20/20)` e aviso para cumprir ou remover itens para liberar vagas (`RN21`, `RN23`).

#### **CT-05: Registro de Estudo em Questões (Modal Completa)**
* **Pré-condições:** Aprofundamento de Questões pendente.
* **Passos:**
  1. Clicar em `Registrar estudo` no card do aprofundamento.
  2. Preencher tempo, questões resolvidas, acertos e motivos de erro (ou preenchimento questão a questão).
  3. Salvar o registro.
* **Resultado Esperado:** Status passa para `Cumprido`, dados são consolidados, vaga é liberada no teto de pendentes e item vincula-se à meta atual.

#### **CT-06: Remoção de Pendente vs. Impossibilidade de Remover Cumprido**
* **Pré-condições:** Aluno com 1 item pendente e 1 item cumprido.
* **Passos:**
  1. No item pendente, clicar no menu de opções e selecionar `Remover`. Confirmar exclusão.
  2. No item cumprido, verificar o menu de opções.
* **Resultado Esperado:** O pendente é excluído sem rastros e libera vaga; o item cumprido **não possui opção de remoção** (`RN33`, `RN34`).

---

## 2. GURUJA-9036 — Fase 1 · Tela de Calendário
*Link Jira:* [GURUJA-9036](https://luby.atlassian.net/browse/GURUJA-9036)  
*Escopo:* Faixa própria abaixo de Reforços, entrada automática no dia de hoje, movimentação entre dias (Drag & Drop) e saída imediata ao cumprir.

### Critérios de Aceite (CAs)
* **CA01:** Faixa "APROFUNDAMENTOS" abaixo de "REFORÇOS", com total de itens, cards com tipo/disciplina/assuntos e dia vazio "—".
* **CA02:** Clique no card abre a modal do item.
* **CA03:** Arrastar card entre dias persiste a nova data via endpoint sem acionar motor de redistribuição da agenda.
* **CA04:** Item novo entra sempre no dia de hoje (`RN39`); nenhuma redistribuição automática.
* **CA05:** Apenas aprofundamentos pendentes aparecem no calendário; cumpridos saem da grade.
* **CA06:** Regressão: atividades e reforços não são afetados pela movimentação de aprofundamentos.
* **CA07:** Responsividade em Desktop, Tablet e Mobile.

### Casos de Teste Detalhados

#### **CT-01: Aprofundamento recém-adicionado entra no dia de hoje**
* **Passos:** Adicionar aprofundamento na Tela de Meta e abrir o Calendário semanal.
* **Resultado Esperado:** O card aparece posicionado exatamente na coluna do dia atual (`RN39`), sem alterar nenhuma atividade ou reforço (`CA04`).

#### **CT-02: Exibição da faixa e informações do card**
* **Passos:** Visualizar a faixa no Calendário com aprofundamentos de tipos variados.
* **Resultado Esperado:** Faixa posicionada logo abaixo de REFORÇOS com texto `"{N} itens"`. Cada card exibe: Tipo (pílula), Disciplina e Quantidade de assuntos (ex.: `Direito Constitucional · 2 assuntos`). Dias sem item mostram `"—"` (`CA01`).

#### **CT-03: Clique no card abre a modal do item**
* **Passos:** Clicar sobre um card de aprofundamento no calendário.
* **Resultado Esperado:** Abre a modal do item com os detalhes e botões de `Abrir caderno` (se Questões) ou `Registrar estudo` (`CA02`).

#### **CT-04: Mover card entre dias e persistência após F5**
* **Passos:** Arrastar um aprofundamento da terça-feira para a quinta-feira. Recarregar a página (`F5`).
* **Resultado Esperado:** O item permanece na quinta-feira após o reload. Nenhuma atividade ou reforço tem sua data alterada (`CA03`, `CA06`).

#### **CT-05: Imunidade à reorganização da agenda**
* **Passos:** Mover aprofundamento para uma data futura e disparar ação de reorganizar agenda.
* **Resultado Esperado:** As atividades da meta são redistribuídas conforme o motor, mas o aprofundamento permanece fixo na data escolhida pelo aluno (`CA04`).

#### **CT-06: Aprofundamento cumprido sai do calendário**
* **Passos:** Clicar em registrar estudo de um card do calendário e salvar a conclusão.
* **Resultado Esperado:** O card desaparece imediatamente da grade do calendário e a contagem da faixa diminui em 1 (`CA05`).

#### **CT-07: Comportamento no Mobile (Interação Touch)**
* **Passos:** Acessar o calendário via smartphone e mover um item de dia.
* **Resultado Esperado:** Card move corretamente pelo gesto touch suportado pelo calendário mobile, mantendo layout responsivo sem quebras (`CA07`).

---

## 3. GURUJA-9038 — Fase 1 · Tela de Arquivo
*Link Jira:* [GURUJA-9038](https://luby.atlassian.net/browse/GURUJA-9038)  
*Escopo:* Histórico de aprofundamentos cumpridos em metas passadas e corrente, contadores no cartão, aba Aprofundamentos com 7 colunas, soma de métricas e perfil Professor.

### Critérios de Aceite (CAs)
* **CA01:** Cartão da meta mostra `{N} reforço(s)` e `{N} aprofundamento(s)` cumpridos com tooltips.
* **CA02:** Terceira aba "Aprofundamentos ⓘ [N]" com tooltip explicativo.
* **CA03:** Tabela com 7 colunas (Nº, Disciplina, Tipo, Assunto, Banca, Tempo, Desempenho) e busca por assunto.
* **CA04:** Somente cumpridos aparecem no Arquivo; pendentes nunca são exibidos.
* **CA05:** Clique na linha abre modal do item (permitida edição pelo aluno mesmo em metas passadas conforme atualização de regra).
* **CA07:** Indicadores de meta e janelas de detalhamento somam aprofundamentos (`RN81`).
* **CA08:** Perfil Professor/Admin acessa lista e detalhe em modo somente leitura (`RN82`).

### Casos de Teste Detalhados

#### **CT-01: Contadores no Cartão da Meta e Indicadores Somados**
* **Passos:** Abrir tela Arquivo, observar o cartão de uma meta com aprofundamentos cumpridos. Abrir a meta e checar indicadores de topo (Tempo, Questões, Acertos, Média Diária).
* **Resultado Esperado:** Cartão exibe contadores de reforços e aprofundamentos cumpridos. Os indicadores de topo refletem a soma das atividades + aprofundamentos cumpridos (`CA01`, `CA07`).

#### **CT-02: Aba Aprofundamentos da Meta: Colunas e Pílulas**
* **Passos:** Entrar na aba Aprofundamentos de uma meta no Arquivo.
* **Resultado Esperado:** Tabela exibe 7 colunas: **Nº, Disciplina, Tipo, Assunto, Banca, Tempo, Desempenho**. Pílula de desempenho: Verde (≥ 80%), Amarela (≥ 60%), Vermelha (< 60%) e `"-"` para tipos teóricos (`CA03`).

#### **CT-03: Busca por Assunto na Tabela**
* **Passos:** Digitar termo no campo "Buscar por assunto" da aba Aprofundamentos.
* **Resultado Esperado:** Lista filtra instantaneamente apenas os aprofundamentos correspondentes ao termo digitado (`CA03`).

#### **CT-04: Isolamento total de itens pendentes**
* **Passos:** Verificar se itens pendentes da meta atual aparecem na aba Aprofundamentos do Arquivo.
* **Resultado Esperado:** Nenhum pendente é exibido no Arquivo. Pendentes pertencem ao planejamento e só aparecem na Tela de Meta (`CA04`).

#### **CT-05: Visualização do Perfil Professor (Somente Leitura)**
* **Passos:** Logar como Professor, navegar até o Arquivo do aluno e abrir a aba Aprofundamentos. Clicar em um item.
* **Resultado Esperado:** Lista e detalhes são exibidos perfeitamente, porém **sem botões de edição, salvar ou excluir** (`CA08`).

#### **CT-06: Estado Vazio em Meta sem Aprofundamentos**
* **Passos:** Abrir uma meta que não teve aprofundamentos cumpridos.
* **Resultado Esperado:** Exibe texto padrão: *"Nenhum aprofundamento cumprido nesta meta. Os pendentes não pertencem a uma meta e aparecem na Meta atual."* (`CA04`).

---

## 4. GURUJA-9101 — Fase 1 · Tela de Padrão de Erros
*Link Jira:* [GURUJA-9101](https://luby.atlassian.net/browse/GURUJA-9101)  
*Escopo:* Integração dos erros de aprofundamentos de Questões no motor de padrão de erros, filtro de origem "Itens" e detalhe por disciplina.

### Critérios de Aceite (CAs)
* **CA01:** Apenas aprofundamentos do tipo Questões entram no Padrão de Erros; tipos teóricos e reforços não entram (`RN51`, `RN52`).
* **CA03:** Novo dropdown "Itens" com 3 opções: `Todos os itens` (padrão), `Atividades`, `Aprofundamentos`.
* **CA04:** Filtro recalcula tabela, detalhe da disciplina e os 3 gráficos: Distribuição, Concentração e Evolução dos motivos (`RN55`).
* **CA05:** Piso de 10 erros com motivo aplica-se a todos os filtros (`RN56`).
* **CA06:** Tabela detalhada exibe coluna Código sem o prefixo "AP-" (ex: `RETRI.FMS.2.Q001`), Assunto e Meta (`RN58`).
* **CA07:** Ordenação por data de cumprimento (desempate: atividades primeiro, depois código).
* **CA08:** Aprofundamentos nunca geram novos reforços no motor (`RN63`).

### Casos de Teste Detalhados

#### **CT-01: Filtro "Itens" e Recálculo dos Gráficos**
* **Passos:** Acessar tela Padrão de Erros. Alternar o filtro "Itens" entre `Todos os itens`, `Atividades` e `Aprofundamentos`.
* **Resultado Esperado:** Tabela de disciplinas e gráficos (Distribuição, Concentração e Evolução) são recalculados instantaneamente de acordo com a seleção (`CA03`, `CA04`).

#### **CT-02: Exclusão de Tipos Teóricos e Reforços**
* **Passos:** Aluno cumpre aprofundamentos de Teoria/Lei Seca e reforços. Abrir Padrão de Erros.
* **Resultado Esperado:** Apenas erros oriundos de aprofundamentos de **Questões** são contabilizados. Reforços e tipos teóricos ficam de fora (`CA01`).

#### **CT-03: Detalhe da Disciplina e Código sem "AP-"**
* **Passos:** Clicar em uma disciplina no Padrão de Erros para abrir a lista detalhada.
* **Resultado Esperado:** Linhas mesclam atividades e aprofundamentos de Questões. A coluna Código exibe o formato `SIGLA.INICIAIS.PLAN.LETRA+SEQ` (ex.: `RETRI.FMS.2.Q001`), sem o prefixo `"AP-"` (`CA06`).

#### **CT-04: Critério de Desempate na Ordenação por Data**
* **Passos:** Identificar atividade e aprofundamento cumpridos na mesma data.
* **Resultado Esperado:** A atividade é listada antes do aprofundamento; dentro de cada grupo, ordena pelo código (`CA07`).

---

## 5. GURUJA-9169 — Fase 1 · Questões — Simulado por Disciplina
*Link Jira:* [GURUJA-9169](https://luby.atlassian.net/browse/GURUJA-9169)  
*Escopo:* Simulado cobrindo toda a disciplina voltado à área do aluno, sem árvore de assuntos, entrega sequencial de versões e regra de 1 simulado pendente por disciplina.

### Critérios de Aceite (CAs)
* **CA01:** Simulado por disciplina x banca disponível em Questões, sem árvore de assuntos (`RN64`, `RN66`).
* **CA03:** Gera aprofundamento próprio de Questões com código `Q`, consumindo 1 vaga e entrando no dia de hoje no calendário.
* **CA04:** Entrega sequencial de versões (v1, v2, v3... até 80 versões) e reinício do ciclo ao esgotar (`RN72`, `RN73`).
* **CA05:** Limite de **1 simulado pendente por disciplina** (independe da banca); nova criação bloqueada até cumprir (`RN71`).
* **CA06:** Versão é controle interno e nunca é exibida ao aluno (`RN74`).
* **CA10:** Cópia própria criada no TEC e orientação do caderno no detalhe (`RN75`, `RN78`).

### Casos de Teste Detalhados

#### **CT-01: Seleção de Simulado na Modal Adicionar**
* **Passos:** Abrir modal Adicionar, escolher disciplina e banca. Selecionar a opção de Simulado.
* **Resultado Esperado:** O simulado é selecionado sem exigir navegação na árvore de assuntos. Coluna seleção mostra `{Banca} · {N} questões · ~30 min` (`CA01`, `CA02`).

#### **CT-02: Bloqueio de Segundo Simulado Pendente na Mesma Disciplina**
* **Passos:**
  1. Adicionar simulado da banca FCC em Direito Constitucional.
  2. Tentar adicionar simulado da banca FGV ou Cebraspe na mesma disciplina Direito Constitucional.
* **Resultado Esperado:** Opção exibe selo `Pendente` com botão desabilitado `Já está pendente`. Sistema rejeita criação de novo simulado na mesma disciplina até que o anterior seja cumprido (`CA05`).

#### **CT-03: Simulado Pendente em Disciplina Diferente Liberado**
* **Passos:** Com simulado pendente em Direito Constitucional, tentar adicionar simulado em Direito Administrativo.
* **Resultado Esperado:** Criação é concluída normalmente, pois o limite de 1 pendente é por disciplina (`CA05`).

#### **CT-04: Entrega Sequencial de Versões**
* **Passos:** Aluno cumpre a versão 1 do simulado da disciplina e adiciona o mesmo simulado novamente.
* **Resultado Esperado:** O sistema entrega a versão 2 daquele caderno. A versão não é exposta em tela nem no JSON de resposta (`CA04`, `CA06`).

#### **CT-05: Falha de Comunicação com TEC Concursos**
* **Passos:** Simular indisponibilidade do serviço do TEC ao adicionar simulado com cópia ligada.
* **Resultado Esperado:** Nenhum aprofundamento é criado e exibe aviso: *"Não foi possível criar o caderno no TEC. Tente novamente em alguns minutos."* (`CA10`).

---

## 6. GURUJA-9039 — Fase 2 (Antecipada) · Tela de Desempenho
*Link Jira:* [GURUJA-9039](https://luby.atlassian.net/browse/GURUJA-9039)  
*Escopo:* Filtro de origem considerando aprofundamentos, KPIs consolidados, gráfico de tempo por dia com dias exclusivos de reforço e tabela por disciplina com detalhe por tipo.

### Critérios de Aceite (CAs)
* **CA01:** Filtro de origem com opções para isolar ou mesclar aprofundamentos com atividades.
* **CA02:** Gráfico de tempo diário exibe dias em que o aluno só fez aprofundamentos ou reforços (`RN84`).
* **CA03:** Tabela por disciplina exibe quantitativo de aprofundamentos discriminados por tipo (`RN84`).

### Casos de Teste Detalhados

#### **CT-01: Filtro de Origem em Desempenho**
* **Passos:** Acessar Desempenho e alternar o filtro de origem entre Atividades, Aprofundamentos e Geral.
* **Resultado Esperado:** KPIs de questões, percentual de acertos e tempo total refletem o escopo selecionado (`CA01`).

#### **CT-02: Gráfico de Tempo com Aprofundamentos**
* **Passos:** Analisar dia em que o aluno cumpriu apenas aprofundamentos (sem atividades da meta).
* **Resultado Esperado:** O dia é renderizado no gráfico de barras com a carga horária correspondente e legenda adequada (`CA02`).

#### **CT-03: Quantidade por Tipo na Tabela de Disciplinas**
* **Passos:** Expandir os detalhes de uma disciplina na tabela de desempenho.
* **Resultado Esperado:** Exibe o número de aprofundamentos realizados divididos por Questões, Teoria, Anotações, Lei Seca e Jurisprudência (`CA03`).

---

## 7. GURUJA-9040 — Fase 2 (Antecipada) · Tela de Jornada
*Link Jira:* [GURUJA-9040](https://luby.atlassian.net/browse/GURUJA-9040)  
*Escopo:* Registro de dias estudados com aprofundamentos, manutenção de sequência (streak) e ponderação de esforço (`RN48`, `RN85`).

### Critérios de Aceite (CAs)
* **CA01:** Dia com apenas aprofundamentos cumpridos conta como dia estudado (`RN85`).
* **CA02:** Sequência de dias (streak) não é interrompida em dia com estudo exclusivo de aprofundamento (`RN85`).
* **CA03:** Ponderação de esforço na cor do dia: **1 atividade = 2 aprofundamentos = 4 reforços** (`RN48`).

### Casos de Teste Detalhados

#### **CT-01: Manutenção do Streak com Apenas Aprofundamento**
* **Passos:** Aluno estuda nos dias 1 e 2 com atividades normais. No dia 3, cumpre apenas 1 aprofundamento de 30 min.
* **Resultado Esperado:** O dia 3 é marcado como dia estudado no calendário da Jornada e o streak acumulado aumenta para 3 dias consecutivos (`CA01`, `CA02`).

#### **CT-02: Cálculo da Ponderação de Esforço (RN48)**
* **Passos:** Cumprir 2 aprofundamentos em um único dia sem atividades.
* **Resultado Esperado:** A carga ponderada equivale a 1 atividade completa (`peso 1.0`), colorindo o dia no calendário com a tonalidade de meta padrão atingida e tooltip explicativo (`CA03`).

---

## 📊 Matriz de Rastreabilidade (Regras de Negócio x Cards)

| Regra de Negócio | Descrição Essencial | Card Principal |
| :--- | :--- | :--- |
| **RN01 - RN05** | Conceito, duração (~30min) e máscara de código único | [GURUJA-9032](https://luby.atlassian.net/browse/GURUJA-9032) |
| **RN06 - RN14** | Tipos, disponibilidade e exclusão de assuntos | [GURUJA-9032](https://luby.atlassian.net/browse/GURUJA-9032) |
| **RN21 - RN23** | Teto de 20 pendentes simultâneos | [GURUJA-9032](https://luby.atlassian.net/browse/GURUJA-9032) |
| **RN32 - RN35** | Ciclo de vida (Pendente -> Cumprido; sem 'ignorado') | [GURUJA-9032](https://luby.atlassian.net/browse/GURUJA-9032) |
| **RN39 - RN40** | Calendário: entrada no dia de hoje e sem redistribuição | [GURUJA-9036](https://luby.atlassian.net/browse/GURUJA-9036) |
| **RN36 - RN37** | Cumpridos no Arquivo da meta; pendentes na Meta | [GURUJA-9038](https://luby.atlassian.net/browse/GURUJA-9038) |
| **RN48** | Ponderação Jornada: 1 atividade = 2 aprofundamentos = 4 reforços | [GURUJA-9040](https://luby.atlassian.net/browse/GURUJA-9040) |
| **RN51 - RN63** | Padrão de erros: apenas Questões com filtro Itens | [GURUJA-9101](https://luby.atlassian.net/browse/GURUJA-9101) |
| **RN64 - RN76** | Simulado por disciplina x banca (1 pendente por disciplina) | [GURUJA-9169](https://luby.atlassian.net/browse/GURUJA-9169) |
| **RN75** | Integração e criação de cópia própria no TEC | [GURUJA-9032](https://luby.atlassian.net/browse/GURUJA-9032) / [GURUJA-9169](https://luby.atlassian.net/browse/GURUJA-9169) |
| **RN81** | Indicadores somando aprofundamentos cumpridos | [GURUJA-9032](https://luby.atlassian.net/browse/GURUJA-9032) / [GURUJA-9038](https://luby.atlassian.net/browse/GURUJA-9038) |
| **RN82** | Professor e outros perfis: somente leitura | [GURUJA-9038](https://luby.atlassian.net/browse/GURUJA-9038) |
| **RN84 - RN85** | Desempenho e Jornada: streak e KPIs com aprofundamentos | [GURUJA-9039](https://luby.atlassian.net/browse/GURUJA-9039) / [GURUJA-9040](https://luby.atlassian.net/browse/GURUJA-9040) |

