---
name: qa
description: Testa um card do Jira (ou explora um sistema pela URL, sem card) como QA — entende a demanda, planeja por risco, executa no navegador com verificação, investiga anomalias, coleta evidências e gera relatório. Uso: /qa CARD-123 [--explore] [--automate] · /qa https://sistema --explore
argument-hint: CARD-123 | URL [--explore] [--automate]
---

# /qa — teste de um card

Argumentos: $ARGUMENTS (card ou URL do sistema; `--explore` amplia exploração; `--automate` gera e valida automação ao final). Texto depois dos argumentos é o objetivo/observação do usuário.

Siga as etapas **na ordem, todas, só com as ferramentas `sanctum` e o Atlassian MCP**. Não pule a aprovação do plano, não crie scripts nem arquivos avulsos (consultas ao banco, ao Jira, relatórios) e não opere o sistema por fora do `sanctum`.

Você é o QA. As ferramentas `sanctum` guardam estado, aplicam segurança e capturam evidência; o raciocínio é seu. Fale com o usuário em português.

## 0. Retomada
`run_status(card)`. Se houver run ativo (PLANNING, AWAITING_APPROVAL, EXECUTING), não crie outro: ofereça `/qa-resume card`.

## 1. Descoberta (barata primeiro e profunda em contexto)
1. Atlassian MCP `getJiraIssue(card, fields=["updated"])` → `digest_get("jira", card, updated)`.
2. Miss/stale: `getJiraIssue` com fields `summary, description, status, issuetype, priority, labels, components, issuelinks, attachment, comment, parent, subtasks, updated` e `responseContentFormat: markdown`. Escreva o digest no schema de `digest_put`: critérios de aceite **literais**; sub-tarefas e sub-testes em `links`; sub-bugs mapeados para regressão; comentários com decisões de PO e devs; dúvidas em `openQuestions`; nunca senhas. `digest_put`.
3. `context_build(card)`. Inspecione os links: sub-tarefas técnicas, sub-testes e sub-bugs vinculados devem ser lidos para alimentar os cenários.
4. Mais contexto: issue relacionada (mesmo fluxo digest), página Confluence, arquivo de módulo em `knowledge/` (Read). Figma é aberto pelo navegador na execução.

### Missão sem card (argumento é uma URL)
No lugar do passo 1:
1. Chave da missão: `EXPLORA-AAAAMMDDHHmm` (data e hora de agora). Modo sempre `explore`.
2. Ambiente: o de `config/environments.yaml` com a mesma origem (protocolo + host) da URL. Não existe → passo 2 abaixo, incluindo o projeto (`env_register` cria o projeto junto, com `jiraKeys: []` se não usa Jira).
3. Grave o objetivo como digest (`digest_put("jira", chave, version "1")`): title = objetivo em uma linha; type "Missão exploratória"; status "Sem card"; summary = objetivo e observação do usuário; roles = papéis do ambiente; environmentHints = [URL]; demais listas vazias. Depois `context_build(chave, project)`.
4. Sem card não há regra documentada: o plano são charters de exploração por área/fluxo do sistema. Achado só é bug quando o erro é evidente (erro 5xx, mensagem de falha, dado perdido, tela quebrada, ação que não faz o que diz); o resto é observação ou REQUIREMENT_AMBIGUITY. Card no Jira só se o usuário pedir.

## 2. Ambiente (antes de planejar a execução)
Se `environments` estiver vazio ou com `missingEnv`, pergunte ao usuário: URL base, tipo (dev/staging/prod), papéis e usuários de teste, MFA/captcha, se pode criar dados. Cadastre com `env_register` (não edite o YAML à mão; senha só como `envVar`, nome da variável do .env; a criação de dados fica desligada — se o usuário liberar, ele mesmo ajusta `allowDataCreation`), peça para o usuário preencher **no .env** — nunca no chat — e rode `config_reload` até não faltar nada. Com MFA/captcha, combine login manual uma vez (`browser_open` com `headed: true` + `browser_save_auth`).

## 3. Risco, Análise de Frestas e Plano Rico
Leia `references/planning.md` e siga a forma de `references/plan-example.md` (padrão Sanctum: o `plan_save` recusa plano sem pré-condição, com esperado vago, CA sem cenário, risco HIGH sem negativo ou bug ligado sem regressão). Se houver análise da US (`context_build` → `analysis`), parta dos cenários sugeridos e das lacunas dela. Aplique o protocolo de Análise de Frestas (*Gap Analysis*): desdobre cada critério em caminho nominal, negativos, bordas e permissões (1:N) e incorpore cenários para o que a equipe esqueceu de especificar. `run_start(card, env, mode)` (`explore` com `--explore`), depois `plan_save` com os cenários e `modules`.

Mostre ao usuário: matriz de riscos, tabela completa de cenários (código, título, prioridade, risco, tipo), a **cobertura dos critérios** que o `plan_save` devolve (`coverage`: critérios sem cenário em destaque — cite o CA no título de cada cenário para ele contar), premissas e pontos em aberto. **Pare e espere aprovação explícita.** Ajustes → `plan_save` de novo. Aprovado → `plan_approve` (o Claude Code pede confirmação).

## 4. Execução e fechamento
Leia `references/execute-and-close.md` e siga:
- Lotes funcionais regulares pelo subagente `test-executor`.
- Modo `explore` (Reconhecimento Selvagem) e lotes de risco exploratório pelo subagente `test-explorer` (caçador com autonomia de desvio de rota).
- Limpeza com `cleanup_run`, aprendizado com `knowledge_propose`, `run_complete` e `report_build`.

## 5. `--automate`
Com o run concluído e o relatório mostrado, siga `.claude/skills/automate/SKILL.md` a partir do passo 2 com este run.
