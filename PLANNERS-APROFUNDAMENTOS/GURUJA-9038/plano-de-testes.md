# Plano de Testes — GURUJA-9038

## 📝 Resumo da demanda
Histórico de aprofundamentos cumpridos em metas passadas e corrente, contadores no cartão, aba Aprofundamentos com 7 colunas, soma de métricas e perfil Professor.

## ✅ Critérios de aceite
- CA01 — Cartão da meta mostra {N} reforço(s) e {N} aprofundamento(s) cumpridos com tooltips
- CA02 — Terceira aba "Aprofundamentos ⓘ [N]" com tooltip explicativo
- CA03 — Tabela com 7 colunas (Nº, Disciplina, Tipo, Assunto, Banca, Tempo, Desempenho) e busca por assunto
- CA04 — Somente cumpridos aparecem no Arquivo; pendentes nunca são exibidos
- CA05 — Clique na linha abre modal do item (permitida edição pelo aluno mesmo em metas passadas)
- CA07 — Indicadores de meta e janelas de detalhamento somam aprofundamentos (RN81)
- CA08 — Perfil Professor/Admin acessa lista e detalhe em modo somente leitura (RN82)

## 🧪 Cenários de teste

### CT-01 — Contadores no Cartão da Meta e Indicadores Somados
**Pré-condições**
- Aluno com aprofundamentos cumpridos em metas arquivadas

**Passos**
1. Abrir tela Arquivo e observar o cartão de uma meta com aprofundamentos cumpridos
2. Abrir a meta detalhada e checar indicadores de topo (Tempo, Questões, Acertos, Média Diária)
3. Verificar os tooltips explicativos

**Resultado esperado**
Cartão exibe contadores de reforços e aprofundamentos cumpridos. Os indicadores de topo refletem a soma das atividades + aprofundamentos cumpridos (CA01, CA07)

### CT-02 — Aba Aprofundamentos da Meta: Colunas e Pílulas
**Pré-condições**
- Meta com aprofundamentos de tipos teóricos e questões cumpridos

**Passos**
1. Entrar na aba Aprofundamentos de uma meta no Arquivo
2. Conferir as colunas: Nº, Disciplina, Tipo, Assunto, Banca, Tempo, Desempenho
3. Verificar a coloração das pílulas de desempenho (verde, amarela, vermelha ou traço)

**Resultado esperado**
Tabela exibe 7 colunas: Nº, Disciplina, Tipo, Assunto, Banca, Tempo, Desempenho. Pílula de desempenho: Verde (≥ 80%), Amarela (≥ 60%), Vermelha (< 60%) e "-" para tipos teóricos (CA03)

### CT-03 — Busca por Assunto na Tabela
**Pré-condições**
- Aba Aprofundamentos aberta com registros cumpridos diversos

**Passos**
1. Digitar termo no campo "Buscar por assunto" da aba Aprofundamentos
2. Avaliar os itens restantes na tabela

**Resultado esperado**
Lista filtra instantaneamente apenas os aprofundamentos correspondentes ao termo digitado (CA03)

### CT-04 — Isolamento total de itens pendentes
**Pré-condições**
- Aluno com itens pendentes ativos no planejamento

**Passos**
1. Verificar se itens pendentes da meta atual aparecem na aba Aprofundamentos do Arquivo
2. Confirmar a ausência de registros sem data de cumprimento

**Resultado esperado**
Nenhum pendente é exibido no Arquivo. Pendentes pertencem ao planejamento e só aparecem na Tela de Meta (CA04)

### CT-05 — Visualização do Perfil Professor (Somente Leitura)
**Pré-condições**
- Usuário autenticado como Professor/Admin

**Passos**
1. Logar como Professor
2. Navegar até o Arquivo do aluno e abrir a aba Aprofundamentos
3. Clicar em um item para visualizar a modal

**Resultado esperado**
Lista e detalhes são exibidos perfeitamente, porém sem botões de edição, salvar ou excluir (CA08)

### CT-06 — Estado Vazio em Meta sem Aprofundamentos
**Pré-condições**
- Meta sem aprofundamentos cumpridos

**Passos**
1. Abrir no Arquivo uma meta que não teve aprofundamentos cumpridos
2. Checar a mensagem na aba Aprofundamentos

**Resultado esperado**
Exibe texto padrão: "Nenhum aprofundamento cumprido nesta meta. Os pendentes não pertencem a uma meta e aparecem na Meta atual." (CA04)

## ⚠️ Observações
Suíte compilada e auditada pelo NOVO QA para o Épico GURUJA-9023. Garante isolamento estrito de pendentes no Arquivo, cálculo integrado de KPIs e modo somente leitura para perfis administrativos.

## 🔗 Link do card
https://luby.atlassian.net/browse/GURUJA-9038
