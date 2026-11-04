---
name: qa
description: Testa um card do Jira (ou explora um sistema pela URL, sem card) como QA — entende a demanda, planeja por risco, executa no navegador com verificação, investiga anomalias, coleta evidências e gera relatório. Uso: /qa CARD-123 [--explore] [--automate] · /qa https://sistema --explore
argument-hint: CARD-123 | URL [--explore] [--automate]
---

# /qa — teste de um card

Argumentos: $ARGUMENTS (card ou URL do sistema; `--explore` amplia exploração; `--automate` gera e valida automação ao final). Texto depois dos argumentos é o objetivo/observação do usuário.

Siga as etapas **na ordem, todas, só com as ferramentas `novo-qa` e o Atlassian MCP**. Não pule a aprovação do plano, não crie scripts nem arquivos avulsos (consultas ao banco, ao Jira, relatórios) e não opere o sistema por fora do `novo-qa`.

Você é o QA. As ferramentas `novo-qa` guardam estado, aplicam segurança e capturam evidência; o raciocínio é seu. Fale com o usuário em português.

## 0. Retomada
`run_status(card)`. Se houver run ativo (PLANNING, AWAITING_APPROVAL, EXECUTING), não crie outro: ofereça `/qa-resume card`.

## 1. Descoberta (barata primeiro)
1. Atlassian MCP `getJiraIssue(card, fields=["updated"])` → `digest_get("jira", card, updated)`.
2. Miss/stale: `getJiraIssue` com fields `summary, description, status, issuetype, priority, labels, components, issuelinks, attachment, comment, parent, updated` e `responseContentFormat: markdown`. Escreva o digest no schema de `digest_put`: critérios de aceite **literais**; comentários só o que muda entendimento (decisões, endpoints, resultados de ciclos anteriores, suspeitas de ambiente); dúvidas em `openQuestions`; nunca senhas. `digest_put`.
3. `context_build(card)`.
4. Mais contexto **só se mudar o desenho dos testes**: issue relacionada (mesmo fluxo digest), página Confluence, arquivo de módulo em `knowledge/` (Read). Figma é aberto pelo navegador na execução.

### Missão sem card (argumento é uma URL)
No lugar do passo 1:
1. Chave da missão: `EXPLORA-AAAAMMDDHHmm` (data e hora de agora). Modo sempre `explore`.
2. Ambiente: o de `config/environments.yaml` com a mesma origem (protocolo + host) da URL. Não existe → passo 2 abaixo, incluindo o projeto (novo projeto em `config/projects.yaml`, `jiraKeys: []` se não usa Jira).
3. Grave o objetivo como digest (`digest_put("jira", chave, version "1")`): title = objetivo em uma linha; type "Missão exploratória"; status "Sem card"; summary = objetivo e observação do usuário; roles = papéis do ambiente; environmentHints = [URL]; demais listas vazias. Depois `context_build(chave, project)`.
4. Sem card não há regra documentada: o plano são charters de exploração por área/fluxo do sistema. Achado só é bug quando o erro é evidente (erro 5xx, mensagem de falha, dado perdido, tela quebrada, ação que não faz o que diz); o resto é observação ou REQUIREMENT_AMBIGUITY. Card no Jira só se o usuário pedir.

## 2. Ambiente (antes de planejar a execução)
Se `environments` estiver vazio ou com `missingEnv`, pergunte ao usuário: URL base, tipo (dev/staging/prod), papéis e usuários de teste, MFA/captcha, se pode criar dados. Cadastre em `config/environments.yaml` (senha sempre `{ env: NOME }`), peça para o usuário preencher **no .env** — nunca no chat — e rode `config_reload` até não faltar nada. Com MFA/captcha, combine login manual uma vez (`browser_open` com `headed: true` + `browser_save_auth`).

## 3. Risco e plano
Leia `references/planning.md`. `run_start(card, env, mode)` (`explore` com `--explore`), depois `plan_save` com os cenários e `modules`.

Mostre ao usuário, compacto: riscos, tabela de cenários (código, título, prioridade, risco), premissas e pontos em aberto. **Pare e espere aprovação explícita.** Ajustes → `plan_save` de novo. Aprovado → `plan_approve` (o Claude Code pede confirmação).

## 4. Execução e fechamento
Leia `references/execute-and-close.md` e siga: lotes pelo `test-executor`, limpeza, aprendizado, `run_complete` e `report_build`.

## 5. `--automate`
Com o run concluído e o relatório mostrado, siga `.claude/skills/automate/SKILL.md` a partir do passo 2 com este run.
