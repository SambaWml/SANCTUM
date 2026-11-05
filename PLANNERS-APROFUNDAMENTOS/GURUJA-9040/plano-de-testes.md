# Plano de Testes — GURUJA-9040

## 📝 Resumo da demanda
Registro de dias estudados com aprofundamentos, manutenção de sequência (streak) e ponderação de esforço (RN48, RN85).

## ✅ Critérios de aceite
- CA01 — Dia com apenas aprofundamentos cumpridos conta como dia estudado (RN85)
- CA02 — Sequência de dias (streak) não é interrompida em dia com estudo exclusivo de aprofundamento (RN85)
- CA03 — Ponderação de esforço na cor do dia: 1 atividade = 2 aprofundamentos = 4 reforços (RN48)

## 🧪 Cenários de teste

### CT-01 — Manutenção do Streak com Apenas Aprofundamento
**Pré-condições**
- Aluno com sequência ativa de estudos de 2 dias

**Passos**
1. Aluno estuda nos dias 1 e 2 com atividades normais
2. No dia 3, cumpre apenas 1 aprofundamento de 30 min
3. Acessar a tela Jornada e checar o streak e a marcação do dia 3

**Resultado esperado**
O dia 3 é marcado como dia estudado no calendário da Jornada e o streak acumulado aumenta para 3 dias consecutivos (CA01, CA02)

### CT-02 — Cálculo da Ponderação de Esforço (RN48)
**Pré-condições**
- Dia de estudo contendo exatamente 2 aprofundamentos cumpridos

**Passos**
1. Cumprir 2 aprofundamentos em um único dia sem atividades
2. Acessar a tela Jornada e verificar o dia no calendário de constância
3. Verificar o tooltip do dia

**Resultado esperado**
A carga ponderada equivale a 1 atividade completa (peso 1.0), colorindo o dia no calendário com a tonalidade de meta padrão atingida e tooltip explicativo (CA03)

## ⚠️ Observações
Suíte compilada e auditada pelo NOVO QA para o Épico GURUJA-9023. Valida a preservação de streak e a regra de ponderação de esforço (RN48) no mapa de calor da Jornada.

## 🔗 Link do card
https://luby.atlassian.net/browse/GURUJA-9040
