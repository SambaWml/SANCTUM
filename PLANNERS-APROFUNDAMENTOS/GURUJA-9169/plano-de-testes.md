# Plano de Testes — GURUJA-9169

## 📝 Resumo da demanda
Simulado cobrindo toda a disciplina voltado à área do aluno, sem árvore de assuntos, entrega sequencial de versões e regra de 1 simulado pendente por disciplina.

## ✅ Critérios de aceite
- CA01 — Simulado por disciplina x banca disponível em Questões, sem árvore de assuntos (RN64, RN66)
- CA03 — Gera aprofundamento próprio de Questões com código Q, consumindo 1 vaga e entrando no dia de hoje no calendário
- CA04 — Entrega sequencial de versões (v1, v2, v3... até 80 versões) e reinício do ciclo ao esgotar (RN72, RN73)
- CA05 — Limite de 1 simulado pendente por disciplina (independe da banca); nova criação bloqueada até cumprir (RN71)
- CA06 — Versão é controle interno e nunca é exibida ao aluno (RN74)
- CA10 — Cópia própria criada no TEC e orientação do caderno no detalhe (RN75, RN78)

## 🧪 Cenários de teste

### CT-01 — Seleção de Simulado na Modal Adicionar
**Pré-condições**
- Aluno com vagas disponíveis na modal Adicionar

**Passos**
1. Abrir modal Adicionar, escolher disciplina e banca
2. Selecionar a opção de Simulado
3. Conferir a coluna Seleção

**Resultado esperado**
O simulado é selecionado sem exigir navegação na árvore de assuntos. Coluna seleção mostra "{Banca} · {N} questões · ~30 min" (CA01, CA02)

### CT-02 — Bloqueio de Segundo Simulado Pendente na Mesma Disciplina
**Pré-condições**
- Simulado pendente ativo em Direito Constitucional

**Passos**
1. Adicionar simulado da banca FCC em Direito Constitucional
2. Tentar adicionar simulado da banca FGV ou Cebraspe na mesma disciplina Direito Constitucional

**Resultado esperado**
Opção exibe selo "Pendente" com botão desabilitado "Já está pendente". Sistema rejeita criação de novo simulado na mesma disciplina até que o anterior seja cumprido (CA05)

### CT-03 — Simulado Pendente em Disciplina Diferente Liberado
**Pré-condições**
- Simulado pendente em Direito Constitucional

**Passos**
1. Com simulado pendente em Direito Constitucional, tentar adicionar simulado em Direito Administrativo
2. Confirmar a adição

**Resultado esperado**
Criação é concluída normalmente, pois o limite de 1 pendente é por disciplina (CA05)

### CT-04 — Entrega Sequencial de Versões
**Pré-condições**
- Versão 1 do simulado previamente cumprida

**Passos**
1. Aluno cumpre a versão 1 do simulado da disciplina e adiciona o mesmo simulado novamente
2. Verificar a interface e os dados da requisição

**Resultado esperado**
O sistema entrega a versão 2 daquele caderno. A versão não é exposta em tela nem no JSON de resposta (CA04, CA06)

### CT-05 — Falha de Comunicação com TEC Concursos
**Pré-condições**
- Instabilidade ou indisponibilidade simulada no TEC Concursos

**Passos**
1. Simular indisponibilidade do serviço do TEC ao adicionar simulado com cópia ligada
2. Confirmar a criação e checar saldo de vagas e itens

**Resultado esperado**
Nenhum aprofundamento é criado e exibe aviso: "Não foi possível criar o caderno no TEC. Tente novamente em alguns minutos." (CA10)

## ⚠️ Observações
Suíte compilada e auditada pelo NOVO QA para o Épico GURUJA-9023. Garante regras de versão sequencial oculta ao aluno e trava estrita de 1 simulado pendente por disciplina.

## 🔗 Link do card
https://luby.atlassian.net/browse/GURUJA-9169
