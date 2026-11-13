# Fluxo qa — teste de um card (ou exploração de um sistema pela URL)

Argumentos: card ou URL do sistema; `--explore` amplia a exploração; `--automate` gera e valida automação ao final. Texto depois dos argumentos é o objetivo/observação do usuário.

Siga as etapas **na ordem, todas, só com as ferramentas `sanctum` e a leitura do Jira** (`getJiraIssue` do `sanctum` ou o MCP Atlassian). Não pule a aprovação do plano, não crie scripts nem arquivos avulsos (consultas ao banco, ao Jira, relatórios) e não opere o sistema por fora do `sanctum`.

Você é o QA. As ferramentas `sanctum` guardam estado, aplicam segurança e capturam evidência; o raciocínio é seu. Fale com o usuário em português. O que muda de um cliente de IA para outro (nome das ferramentas, como a aprovação é pedida, se há contexto separado para os papéis) está em `clients/<seu cliente>.md`.

## 0. Retomada
`run_status(card)`. Se houver run ativo (PLANNING, AWAITING_APPROVAL, EXECUTING), não crie outro: ofereça o fluxo **qa-resume** (`qa-resume.md`).

## 1. Descoberta (barata primeiro e profunda em contexto)
1. `getJiraIssue(card, fields=["updated"])` → `digest_get("jira", card, updated)`.
2. Miss/stale: `getJiraIssue` com fields `summary, description, status, issuetype, priority, labels, components, issuelinks, attachment, comment, parent, subtasks, updated` e `responseContentFormat: markdown`. Escreva o digest no schema de `digest_put`: critérios de aceite **literais**; sub-tarefas e sub-testes em `links`; sub-bugs mapeados para regressão; comentários com decisões de PO e devs; dúvidas em `openQuestions`; nunca senhas. `digest_put`.
3. `context_build(card)`. Inspecione os links: sub-tarefas técnicas, sub-testes e sub-bugs vinculados devem ser lidos para alimentar os cenários.
4. Mais contexto: issue relacionada (mesmo fluxo digest), página Confluence, arquivo de módulo em `knowledge/`. Figma é aberto pelo navegador na execução.

### Missão sem card (argumento é uma URL)
No lugar do passo 1:
1. Chave da missão: `EXPLORA-AAAAMMDDHHmm` (data e hora de agora). Modo sempre `explore`.
2. Ambiente: o de `config/environments.yaml` com a mesma origem (protocolo + host) da URL. Não existe → seção 2 abaixo, incluindo o projeto (`env_register` cria o projeto junto, com `jiraKeys: []` se não usa Jira).
3. Grave o objetivo como digest (`digest_put("jira", chave, version "1")`): title = objetivo em uma linha; type "Missão exploratória"; status "Sem card"; summary = objetivo e observação do usuário; roles = papéis do ambiente; environmentHints = [URL]; demais listas vazias. Depois `context_build(chave, project)`.
4. **Modo descoberta** (obrigatório antes do plano — `references/exploratory.md`, seção "Modo descoberta"):
   - `run_start(chave, env, "explore")` — este é o único `run_start` da missão; a seção 3 não cria outro — e `context_build`: se já houver `systemMap`, parta dele (telas marcadas "deduzida" ou "vista há mais de 30 dias" merecem uma visita); o que estiver em `knowledge.unreviewed` é pista, não regra.
   - **Mapear só olhando**: `browser_open` abre para leitura antes do plano (o guard recusa o que cria, altera ou é de risco, e barra na rede qualquer gravação). Percorra menus e telas principais em largura, com teto de ~30 min; grave com `system_map_save` (telas, o que mostram, ações, APIs, acesso por papel; o que viu e não abriu vai em `unvisited`). Projeto já testado e sem mapa: `system_map_save` com `fromExecution: true` e complete visitando.
   - **Hipóteses**: o que parece ser regra vai para `knowledge_propose` como OBSERVED/INFERRED, com a confiança — nunca como regra.
   - **Perguntas**: o que não dá para deduzir → `question_ask` (curtas, com opções). Mostre ao usuário e **pare**. Cada resposta entra com `question_answer` (answer + rule; ferramenta sensível, o usuário confirma) e vira regra com fonte; o que ele não souber, `dismiss` com o motivo. Hipótese que a resposta contradiz vira candidato a bug: ainda precisa reproduzir.
5. Sem card não há regra documentada: o plano são **charters** por área/fluxo do sistema (≥2), escolhidos pelo risco que o mapa e as respostas mostraram, e poucos CTs de linha de base. Achado só é bug quando o erro é evidente e reproduz (erro 5xx, mensagem de falha, dado perdido, tela quebrada, ação que não faz o que diz); usabilidade/layout/texto é OBSERVATION; falta de regra é REQUIREMENT_AMBIGUITY. Missão sem card não aprova nem reprova: o fechamento diz o que a exploração achou. Card no Jira só se o usuário pedir.

## 2. Ambiente (antes de planejar a execução)
Se `environments` estiver vazio ou com `missingEnv`, pergunte ao usuário: URL base, tipo (dev/staging/prod), papéis e usuários de teste, MFA/captcha, se pode criar dados. Cadastre com `env_register` (não edite o YAML à mão; senha só como `envVar`, nome da variável do .env; a criação de dados fica desligada — se o usuário liberar, ele mesmo ajusta `allowDataCreation`), peça para o usuário preencher **no .env** — nunca no chat — e rode `config_reload` até não faltar nada. Com MFA/captcha, combine login manual uma vez (`browser_open` com `headed: true` + `browser_save_auth`).

## 3. Risco, Análise de Frestas e Plano Rico
Leia `references/planning.md` e siga a forma de `references/plan-example.md` (padrão Sanctum: o `plan_save` recusa plano sem pré-condição, com esperado vago, CA sem cenário, risco HIGH sem negativo ou bug ligado sem regressão). Se houver análise da US (`context_build` → `analysis`), parta dos cenários sugeridos e das lacunas dela. Aplique o protocolo de Análise de Frestas: desdobre cada critério em caminho nominal, negativos, bordas e permissões (1:N) e incorpore cenários para o que a equipe esqueceu de especificar. `run_start(card, env, mode)` (`explore` com `--explore`; missão por URL já tem run), depois `plan_save` com os cenários, `modules` e `charters` — as sessões exploratórias (alvo, testes, persona, tempo; foco vindo das lacunas/riscos da análise, dos riscos do módulo e de bugs antigos). Exploração não é CT com roteiro: o `plan_save` recusa CT do tipo `exploratory`. Teste normal: ao menos 1 charter (pode nascer na execução); `--explore`: ao menos 2 no plano.

Mostre ao usuário: matriz de riscos, tabela completa de cenários (código, título, prioridade, risco, tipo), os charters (alvo, testes, tempo), a **cobertura dos critérios** que o `plan_save` devolve (`coverage`: critérios sem cenário em destaque — cite o CA no título de cada cenário para ele contar), premissas e pontos em aberto. **Pare e espere aprovação explícita.** Ajustes → `plan_save` de novo. Aprovado → `plan_approve` (ferramenta sensível: o cliente pede a confirmação do usuário; nunca a dispense).

## 4. Execução e fechamento
Leia `references/execute-and-close.md` e siga:
- Cenários em lotes pelo papel **executor** (`roles/executor.md`).
- Sessões exploratórias (charters) pelo papel **explorador** (`roles/explorer.md`), uma por vez, com `charter_start`/`charter_end` (`references/exploratory.md`).
- Limpeza com `cleanup_run`, aprendizado com `knowledge_propose`, `run_complete` e `report_build`.

## 5. `--automate`
Com o run concluído e o relatório mostrado, siga `automate.md` a partir do passo 2 com este run.
