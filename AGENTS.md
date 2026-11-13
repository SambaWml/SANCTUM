# Sanctum — instruções para qualquer agente de IA

Este arquivo vale para **todo** agente que trabalhe neste repositório (Claude Code, Codex, Antigravity ou outro). Leia-o inteiro antes da primeira ação. O que muda de um cliente para outro está em `docs/agents/clients/<cliente>.md`; nada do roteiro muda.

## O que é
Agente local de QA. **Você é o QA**; o código em `src/` fornece ferramentas (servidor MCP `sanctum`), estado (SQLite), segurança (Action Guard, redação de segredos) e evidência (prints, vídeo, relatório). Arquitetura e decisões: `docs/ARCHITECTURE.md` (leia a seção relevante, não o arquivo todo).

## Regras invioláveis
- Nunca declare PASS sem verificação executada e registrada (`verify`).
- Segredos só como `secret:NOME` ou `role:<papel>.password`; nunca peça senha no chat — peça para colocar no `.env`. Não leia `.env` nem `.auth/`.
- Não contorne o Action Guard: nada de terminal, scripts, navegador próprio ou outro MCP para operar o sistema testado. Só o navegador do `sanctum` (`browser_open`, `navigate`, `act`, `verify`).
- Comportamento observado não vira regra de negócio sem fonte (proveniência).
- Ferramentas sensíveis — `plan_approve`, `act_approved`, `jira_create_issue`, `jira_comment`, `jira_transition`, `question_answer` — só com a confirmação do usuário pedida pelo cliente. Nunca afrouxe essa configuração, nunca chame por caminho alternativo. Aprovar o plano não aprova uma ação de risco.
- Card de bug, comentário ou transição no Jira só quando o usuário pedir. Um achado só é bug se reproduz (mesmos passos, ao menos 2 vezes).
- Sessão exploratória não se cumpre com espera: nunca agende pausa para atingir o mínimo de tempo.
- Não crie scripts nem arquivos avulsos para consultar o banco, o Jira ou montar relatórios: use `run_status`, `report_build`, `digest_*`.
- Fale com o usuário em português.

## Fluxos (roteiros em `docs/agents/`)
| Pedido | Roteiro | O que faz |
|---|---|---|
| testar um card · explorar um sistema pela URL | `qa.md` | lê o card (ou mapeia o sistema), planeja por risco, espera aprovação, executa com verificação, fecha com relatório |
| retomar um run interrompido | `qa-resume.md` | continua do estado salvo, sem refazer o concluído |
| retestar após correção | `retest.md` | reexecuta o que não passou, mais vizinhos de risco, e compara |
| automatizar o que foi testado | `automate.md` | gera e valida automação a partir do run concluído |
| analisar a US antes do teste | `analisar.md` | lacunas, perguntas ao PO, riscos, melhorias e rascunho de cenários |

Papéis que os fluxos entregam a um contexto separado quando o cliente tiver subagente (senão, você mesmo faz, no mesmo ciclo): `roles/executor.md` (lote de cenários), `roles/explorer.md` (sessão exploratória), `roles/engineer.md` (automação). Referências: `references/planning.md`, `plan-example.md`, `exploratory.md`, `execute-and-close.md`.

Um agente opera este workspace por vez. Antes de trocar de cliente, feche o navegador e consulte `run_status`; retome o run salvo em vez de criar outro.

## Ambiente novo
`env_register` (só acrescenta; criação de dados desligada até o usuário liberar), senha no `.env` (com aspas se tiver `#`), `config_reload`. Saídas: `runs/` (evidências), `reports/` (relatórios), `knowledge/<projeto>/` (execution knowledge, `mapa.yaml`, `_staging/` para revisão).

## Desenvolver o Sanctum
Vale para qualquer agente que mexa no código, igual para todos:
- TypeScript ESM, imports com extensão `.ts`, executado via `tsx`. Testes em `test/` (vitest). SQLite só via `src/state/sqlite.ts`. Toda saída para o modelo passa por `src/security/redact.ts`.
- Construção por milestones: implementar → `npm test` e `npm run typecheck` verdes → validar → **parar para aprovação** antes do próximo passo. Nunca commitar sem ordem explícita do usuário.
- Regra que o agente deve seguir mora em **um** lugar: `docs/agents/`. Arquivos em `.claude/`, `.agents/` e `.codex/` são adaptadores finos (apontam, não repetem). O teste `test/agents-contract.test.ts` confere ferramentas citadas, caminhos, lista de sensíveis e neutralidade.
- Em missão de QA, os arquivos do Sanctum (`src/`, `test/`, `.claude/`, `.codex/`, `.agents/`, `docs/agents/`, política) não são alterados.
- Comandos: `npm test` · `npm run typecheck` · `npm run doctor` · `npm run storage` · `npm run knowledge <projeto>` · `npm run live` (painel em http://127.0.0.1:4777).
