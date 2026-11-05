# Plano de Testes — GURUJA-9101

## 📝 Resumo da demanda
Integração dos erros de aprofundamentos de Questões no motor de padrão de erros, filtro de origem "Itens" e detalhe por disciplina.

## ✅ Critérios de aceite
- CA01 — Apenas aprofundamentos do tipo Questões entram no Padrão de Erros; tipos teóricos e reforços não entram (RN51, RN52)
- CA03 — Novo dropdown "Itens" com 3 opções: Todos os itens (padrão), Atividades, Aprofundamentos
- CA04 — Filtro recalcula tabela, detalhe da disciplina e os 3 gráficos: Distribuição, Concentração e Evolução dos motivos (RN55)
- CA05 — Piso de 10 erros com motivo aplica-se a todos os filtros (RN56)
- CA06 — Tabela detalhada exibe coluna Código sem o prefixo "AP-" (ex: RETRI.FMS.2.Q001), Assunto e Meta (RN58)
- CA07 — Ordenação por data de cumprimento (desempate: atividades primeiro, depois código)
- CA08 — Aprofundamentos nunca geram novos reforços no motor (RN63)

## 🧪 Cenários de teste

### CT-01 — Filtro "Itens" e Recálculo dos Gráficos
**Pré-condições**
- Aluno com erros registrados em atividades e em aprofundamentos de Questões

**Passos**
1. Acessar tela Padrão de Erros
2. Alternar o filtro "Itens" entre "Todos os itens", "Atividades" e "Aprofundamentos"
3. Observar a atualização das tabelas e gráficos

**Resultado esperado**
Tabela de disciplinas e gráficos (Distribuição, Concentração e Evolução) são recalculados instantaneamente de acordo com a seleção (CA03, CA04)

### CT-02 — Exclusão de Tipos Teóricos e Reforços
**Pré-condições**
- Aluno cumpriu aprofundamentos de Teoria/Lei Seca e reforços

**Passos**
1. Aluno cumpre aprofundamentos de Teoria/Lei Seca e reforços
2. Abrir Padrão de Erros e verificar as origens computadas

**Resultado esperado**
Apenas erros oriundos de aprofundamentos de Questões são contabilizados. Reforços e tipos teóricos ficam de fora (CA01)

### CT-03 — Detalhe da Disciplina e Código sem "AP-"
**Pré-condições**
- Disciplina com aprofundamentos de questões concluídos

**Passos**
1. Clicar em uma disciplina no Padrão de Erros para abrir a lista detalhada
2. Verificar os códigos das linhas de aprofundamentos

**Resultado esperado**
Linhas mesclam atividades e aprofundamentos de Questões. A coluna Código exibe o formato SIGLA.INICIAIS.PLAN.LETRA+SEQ (ex.: RETRI.FMS.2.Q001), sem o prefixo "AP-" (CA06)

### CT-04 — Critério de Desempate na Ordenação por Data
**Pré-condições**
- Atividade e aprofundamento cumpridos na mesma data

**Passos**
1. Identificar atividade e aprofundamento cumpridos na mesma data
2. Verificar a ordem de exibição na lista

**Resultado esperado**
A atividade é listada antes do aprofundamento; dentro de cada grupo, ordena pelo código (CA07)

## ⚠️ Observações
Suíte compilada e auditada pelo NOVO QA para o Épico GURUJA-9023. Valida a integração exclusiva dos aprofundamentos de Questões no Padrão de Erros e recálculo dos gráficos analíticos.

## 🔗 Link do card
https://luby.atlassian.net/browse/GURUJA-9101
