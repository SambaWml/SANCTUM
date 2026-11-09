# Plano de referência (padrão Sanctum)

Modelo real (card de uma plataforma de estudos, Jornada × aprofundamentos, 18 cenários: 15 planejados + 3 EXP). Vale para qualquer sistema: copie a **forma**, não o conteúdo. O `plan_save` recusa o plano que não segue as regras abaixo.

## Regras que o Sanctum confere

| Regra | Como fica no cenário |
|---|---|
| Pré-condição em todo cenário | Quem (papel do `environments.yaml`), quais dados e em que estado, e se é só leitura |
| Esperado verificável | O que aparece na tela, a URL, a requisição/status ou o dado salvo — com números. Nunca "funciona corretamente" |
| Todo CA com cenário | Cite o CA no título: `(CA03)`. Sem cenário → `waivers` com motivo (ex.: PO tirou do escopo) |
| Risco HIGH tem negativo/permissão/validação | Pelo menos um cenário do que **não** pode acontecer (dado inválido, papel sem permissão, limite) |
| Bug ligado ao card vira regressão | Cenário que cite a chave do bug e confirme que não voltou |
| Exploração | Teste normal: ≥1 EXP executado; exploratório: ≥3. Sem isso, `run_complete` pede `noExplorationReason` |

## Cenários planejados (trecho)

```yaml
- code: CT-001
  title: Aprofundamento pendente não conta na Jornada (CA02, negativo)
  priority: P1
  risk: HIGH
  types: [negative, regression]
  preconditions: Aluno B (papel aluno-b); somente leitura. Usar aprofundamento pendente existente; se não houver, BLOCKED sem criar
  steps: [Listar aprofundamentos pendentes do Aluno B na API, Conferir na Jornada/DaysOfStudy que o dia deles não conta]
  expected: Pendente não soma totalDeepDives nem marca dia de estudo

- code: CT-002
  title: Dia com aprofundamento cumprido conta como dia de estudo (CA02)
  priority: P0
  risk: HIGH
  types: [functional, regression]
  preconditions: Aluno B; 28/10 com 6 aprofundamentos cumpridos
  steps: [Abrir /aluno/jornada (outubro/2026), Conferir o quadrado de 28/10 e DaysOfStudy?studyMonth=2026/10/01]
  expected: 28/10 marcado como dia de estudo; API totalDeepDives=6

- code: CT-006
  title: Contadores da Jornada incluem dias com aprofundamentos e persistem
  priority: P1
  risk: MEDIUM
  types: [functional, regression]
  preconditions: Aluno B
  steps: [Anotar dias de estudo e sequência, Recarregar e conferir]
  expected: Contadores consideram 27 e 28/10 e não mudam ao recarregar      # persistência = verificação forte

- code: CT-009
  title: Regressão — dias sem aprofundamento e aluno sem aprofundamentos
  priority: P1
  risk: MEDIUM
  types: [regression]
  preconditions: Aluno B (dias anteriores) e aluno principal (papel aluno) sem aprofundamentos
  steps: [Conferir dias só com atividades/reforços, Conferir a Jornada de aluno sem aprofundamentos]
  expected: Cores e contagens iguais à API; nada mudou para quem não tem aprofundamentos

- code: CT-010
  title: Layout da Jornada em 1366, 768 e 390 (CA06)
  priority: P3
  risk: LOW
  types: [visual, regression]
  preconditions: Aluno B
  steps: [Screenshot em 1366, 768 e 390, Abrir tooltip no celular/tablet]
  expected: Legível, sem corte e sem rolagem horizontal; 28/10 com a cor de Estudo forte

- code: CT-015
  title: Exploratório — Jornada e Aprofundamentos procurando problemas novos
  priority: P2
  risk: MEDIUM
  types: [exploratory]
  preconditions: Aluno B; somente leitura (sem cumprir, antecipar, iniciar, ignorar ou remover nada)
  steps: [Navegar meses (set/out/nov) na Jornada, Abrir Aprofundamentos e Visão geral, Conferir console e rede (4xx/5xx)]
  expected: Sem erros novos; cada problema vira cenário EXP com evidência
```

O que mostra: cada critério tem caminho feliz **e** o que não pode acontecer; regressão de quem não é afetado (CT-009); persistência (recarregar); telas vizinhas que a mudança toca (Meta, Arquivo); layout só onde o card pede; um cenário reservado para explorar.

## EXP: criados durante a execução

Quando algo foge do esperado ou você explora em volta do risco, registre na hora com `scenario_add` (vira `EXP-NNN`, com `parentCode` de onde nasceu) e execute com verificação:

```yaml
- code: EXP-002            # nasceu comparando telas vizinhas
  title: Contador do botão Aprofundamentos diverge entre Meta (0) e Arquivo (6) para a mesma 5ª meta
  priority: P3
  types: [functional, regression]
  preconditions: Aluno B; 5ª meta com 6 aprofundamentos cumpridos e 0 pendentes; só leitura
  steps: [Ler o rótulo do botão na Visão geral, Ler o rótulo no Arquivo > 5ª Meta, Comparar com GET /v2/Students/Me/DeepDives]
  expected: Registrar se a Meta conta só os pendentes (0) e o Arquivo o total; sem regra no card → NEEDS_REVIEW

- code: EXP-003            # nasceu do CT-015 (exploratório)
  parentCode: CT-015
  title: Média ativ. por dia exibida com ponto decimal (1.83) em vez de vírgula pt-BR
  priority: P3
  types: [visual, regression]
  preconditions: Aluno B; setembro/2026 com média 22/12 = 1,83
  steps: [Abrir /aluno/jornada, Ir para setembro/2026, Ler a Média e comparar com averageActivitiesPerDay]
  expected: Número em pt-BR (1,83); hoje a tela mostra "1.83 atividades", o valor cru da API
```

Onde procurar EXP: o que o card não cobre (estados vazio/erro/carregando, permissão, limites), telas vizinhas que usam o mesmo dado, recarregar e voltar, outro papel de usuário, console e rede. EXP visto uma vez é observação (NEEDS_REVIEW); só vira bug se reproduzir.
