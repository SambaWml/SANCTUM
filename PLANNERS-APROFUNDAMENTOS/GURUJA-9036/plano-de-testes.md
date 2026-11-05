# Plano de Testes — GURUJA-9036

## 📝 Resumo da demanda
Faixa própria abaixo de Reforços, entrada automática no dia de hoje, movimentação entre dias (Drag & Drop) e saída imediata ao cumprir no Calendário.

## ✅ Critérios de aceite
- CA01 — Faixa "APROFUNDAMENTOS" abaixo de "REFORÇOS", com total de itens, cards com tipo/disciplina/assuntos e dia vazio "—"
- CA02 — Clique no card abre a modal do item
- CA03 — Arrastar card entre dias persiste a nova data via endpoint sem acionar motor de redistribuição da agenda
- CA04 — Item novo entra sempre no dia de hoje (RN39); nenhuma redistribuição automática
- CA05 — Apenas aprofundamentos pendentes aparecem no calendário; cumpridos saem da grade
- CA06 — Regressão: atividades e reforços não são afetados pela movimentação de aprofundamentos
- CA07 — Responsividade em Desktop, Tablet e Mobile

## 🧪 Cenários de teste

### CT-01 — Aprofundamento recém-adicionado entra no dia de hoje
**Pré-condições**
- Aprofundamento recém-adicionado na Tela de Meta

**Passos**
1. Adicionar aprofundamento na Tela de Meta
2. Abrir o Calendário semanal
3. Verificar o posicionamento na coluna do dia de hoje

**Resultado esperado**
O card aparece posicionado exatamente na coluna do dia atual (RN39), sem alterar nenhuma atividade ou reforço (CA04)

### CT-02 — Exibição da faixa e informações do card
**Pré-condições**
- Aluno com aprofundamentos cadastrados no calendário semanal

**Passos**
1. Visualizar a faixa no Calendário com aprofundamentos de tipos variados
2. Conferir a ordem das faixas (abaixo de REFORÇOS)
3. Verificar os dados exibidos em cada card e nos dias sem itens

**Resultado esperado**
Faixa posicionada logo abaixo de REFORÇOS com texto "{N} itens". Cada card exibe: Tipo (pílula), Disciplina e Quantidade de assuntos (ex.: Direito Constitucional · 2 assuntos). Dias sem item mostram "—" (CA01)

### CT-03 — Clique no card abre a modal do item
**Pré-condições**
- Card de aprofundamento visível no calendário

**Passos**
1. Clicar sobre um card de aprofundamento no calendário
2. Verificar a abertura da modal com detalhes e ações

**Resultado esperado**
Abre a modal do item com os detalhes e botões de "Abrir caderno" (se Questões) ou "Registrar estudo" (CA02)

### CT-04 — Mover card entre dias e persistência após F5
**Pré-condições**
- Card de aprofundamento posicionado na terça-feira

**Passos**
1. Arrastar um aprofundamento da terça-feira para a quinta-feira
2. Recarregar a página (F5)
3. Verificar a persistência da coluna e as datas das atividades

**Resultado esperado**
O item permanece na quinta-feira após o reload. Nenhuma atividade ou reforço tem sua data alterada (CA03, CA06)

### CT-05 — Imunidade à reorganização da agenda
**Pré-condições**
- Aprofundamento posicionado em data futura

**Passos**
1. Mover aprofundamento para uma data futura
2. Disparar ação de reorganizar agenda
3. Conferir o calendário

**Resultado esperado**
As atividades da meta são redistribuídas conforme o motor, mas o aprofundamento permanece fixo na data escolhida pelo aluno (CA04)

### CT-06 — Aprofundamento cumprido sai do calendário
**Pré-condições**
- Card de aprofundamento pendente visível no calendário

**Passos**
1. Clicar em registrar estudo de um card do calendário
2. Preencher os dados e salvar a conclusão
3. Observar a atualização da grade do calendário

**Resultado esperado**
O card desaparece imediatamente da grade do calendário e a contagem da faixa diminui em 1 (CA05)

### CT-07 — Comportamento no Mobile (Interação Touch)
**Pré-condições**
- Acesso ao calendário via smartphone ou viewport mobile

**Passos**
1. Acessar o calendário via smartphone
2. Mover um item de dia utilizando gesto touch suportado
3. Verificar alinhamento e estabilidade do layout

**Resultado esperado**
Card move corretamente pelo gesto touch suportado pelo calendário mobile, mantendo layout responsivo sem quebras (CA07)

## ⚠️ Observações
Suíte compilada e auditada pelo NOVO QA para o Épico GURUJA-9023. Garante imunidade dos aprofundamentos ao motor de reorganização da agenda e persistência isolada por drag-and-drop.

## 🔗 Link do card
https://luby.atlassian.net/browse/GURUJA-9036
