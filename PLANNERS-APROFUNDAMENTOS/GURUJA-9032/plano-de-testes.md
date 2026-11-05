# Plano de Testes — GURUJA-9032

## 📝 Resumo da demanda
Criação, catálogo, vagas (teto 20), tipos (Questões, Teoria, Anotações, Lei Seca, Jurisprudência), assuntos cobertos, cópia TEC e registro de estudo na Tela de Meta.

## ✅ Critérios de aceite
- CA01 — Aba Aprofundamentos na Lista da Meta com contador, tabela agrupada por disciplina, botão Adicionar e teto de vagas
- CA02 — Modal de Adicionar com fluxo em 3 passos: Disciplina -> Tipo -> Assunto(s) ou Simulado
- CA03 — Integração TEC (Questões): criação de cópia própria nomeada com o código do item (RN05)
- CA04 — Assuntos cobertos: selecionar capítulo marca automaticamente todos os subassuntos (RN77)
- CA05 — Teto de 20 pendentes: botão desabilita ao atingir limite (RN21)
- CA06 — Registro de conclusão: Questões abre modal completa (questão a questão); demais tipos registram tempo (hh:mm)
- CA07 — Remoção: apenas itens pendentes podem ser removidos; cumpridos não podem ser excluídos (RN33, RN34)

## 🧪 Cenários de teste

### CT-01 — Exibição da aba Aprofundamentos e contador de vagas
**Pré-condições**
- Aluno com planejamento e meta ativa

**Passos**
1. Acessar a Tela de Meta (visão Lista)
2. Localizar as abas principais: Atividades, Reforços e Aprofundamentos
3. Verificar o cabeçalho da aba Aprofundamentos e o saldo de vagas (X de 20 vagas disponíveis)

**Resultado esperado**
Aba visível, contador reflete o número real de pendentes e botão "+ Adicionar aprofundamento" habilitado (CA01)

### CT-02 — Criação de Aprofundamento de Questões com Cópia TEC
**Pré-condições**
- Aluno com vagas disponíveis e integração TEC ativa

**Passos**
1. Clicar em "+ Adicionar aprofundamento"
2. Selecionar uma disciplina e o tipo Questões
3. Selecionar a banca e um assunto com caderno disponível
4. Confirmar a criação

**Resultado esperado**
Item criado na meta com código padrão RN05 (ex: DIRAD.ABC.1.Q001), caderno gerado no TEC com nome idêntico ao código e 1 vaga consumida (CA02, CA03)

### CT-03 — Criação de Teoria/Lei Seca com múltiplos assuntos e capítulos (Assuntos Cobertos)
**Pré-condições**
- Aluno na modal Adicionar aprofundamento

**Passos**
1. Selecionar tipo Teoria ou Lei Seca
2. Marcar um capítulo pai que contenha subassuntos
3. Observar a marcação automática dos descendentes
4. Confirmar a criação

**Resultado esperado**
Todos os subassuntos são registrados como "cobertos" (RN77); detalhe exibe a árvore de assuntos e orientação personalizada das 3 principais cobranças da banca (RN78, CA04)

### CT-04 — Bloqueio por Teto Máximo de 20 Pendentes
**Pré-condições**
- Aluno com 20 aprofundamentos pendentes acumulados

**Passos**
1. Abrir a Tela de Meta
2. Observar o botão "+ Adicionar aprofundamento"
3. Tentar abrir a modal de criação

**Resultado esperado**
Botão desabilitado com indicação "Limite atingido (20/20)" e aviso para cumprir ou remover itens para liberar vagas (RN21, RN23, CA05)

### CT-05 — Registro de Estudo em Questões (Modal Completa)
**Pré-condições**
- Aprofundamento de Questões pendente

**Passos**
1. Clicar em "Registrar estudo" no card do aprofundamento
2. Preencher tempo, questões resolvidas, acertos e motivos de erro (ou preenchimento questão a questão)
3. Salvar o registro

**Resultado esperado**
Status passa para "Cumprido", dados são consolidados, vaga é liberada no teto de pendentes e item vincula-se à meta atual (CA06)

### CT-06 — Remoção de Pendente vs. Impossibilidade de Remover Cumprido
**Pré-condições**
- Aluno com 1 item pendente e 1 item cumprido

**Passos**
1. No item pendente, clicar no menu de opções e selecionar "Remover", confirmando a exclusão
2. No item cumprido, verificar o menu de opções

**Resultado esperado**
O pendente é excluído sem rastros e libera vaga; o item cumprido não possui opção de remoção (RN33, RN34, CA07)

## ⚠️ Observações
Suíte compilada e auditada pelo NOVO QA para o Épico GURUJA-9023. Abrange catálogo, limite de vagas, árvore de assuntos cobertos, integração de cópia própria com TEC e ciclo de vida.

## 🔗 Link do card
https://luby.atlassian.net/browse/GURUJA-9032
