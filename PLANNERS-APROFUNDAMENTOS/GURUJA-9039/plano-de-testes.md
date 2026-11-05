# Plano de Testes — GURUJA-9039

## 📝 Resumo da demanda
Filtro de origem considerando aprofundamentos, KPIs consolidados, gráfico de tempo por dia com dias exclusivos de reforço/aprofundamento e tabela por disciplina com detalhe por tipo.

## ✅ Critérios de aceite
- CA01 — Filtro de origem com opções para isolar ou mesclar aprofundamentos com atividades
- CA02 — Gráfico de tempo diário exibe dias em que o aluno só fez aprofundamentos ou reforços (RN84)
- CA03 — Tabela por disciplina exibe quantitativo de aprofundamentos discriminados por tipo (RN84)

## 🧪 Cenários de teste

### CT-01 — Filtro de Origem em Desempenho
**Pré-condições**
- Aluno com atividades e aprofundamentos cumpridos

**Passos**
1. Acessar Desempenho
2. Alternar o filtro de origem entre Atividades, Aprofundamentos e Geral
3. Conferir os valores dos KPIs principais

**Resultado esperado**
KPIs de questões, percentual de acertos e tempo total refletem o escopo selecionado (CA01)

### CT-02 — Gráfico de Tempo com Aprofundamentos
**Pré-condições**
- Dia com cumprimento exclusivo de aprofundamentos

**Passos**
1. Analisar dia em que o aluno cumpriu apenas aprofundamentos (sem atividades da meta)
2. Verificar a renderização no gráfico diário

**Resultado esperado**
O dia é renderizado no gráfico de barras com a carga horária correspondente e legenda adequada (CA02)

### CT-03 — Quantidade por Tipo na Tabela de Disciplinas
**Pré-condições**
- Disciplinas com aprofundamentos cumpridos de tipos variados

**Passos**
1. Expandir os detalhes de uma disciplina na tabela de desempenho
2. Conferir a divisão dos quantitativos por tipo

**Resultado esperado**
Exibe o número de aprofundamentos realizados divididos por Questões, Teoria, Anotações, Lei Seca e Jurisprudência (CA03)

## ⚠️ Observações
Suíte compilada e auditada pelo NOVO QA para o Épico GURUJA-9023. Valida a integração analítica dos aprofundamentos na tela de Desempenho com suporte a isolamento por origem e detalhamento por tipo.

## 🔗 Link do card
https://luby.atlassian.net/browse/GURUJA-9039
