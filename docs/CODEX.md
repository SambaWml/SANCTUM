# Usar o Sanctum pelo Codex

O mesmo servidor MCP pode ser comandado pelo Claude Code ou pelo Codex local
(CLI/IDE compatível). O núcleo, os dados e os roteiros são compartilhados.
Os arquivos `.claude/`, `CLAUDE.md` e `.mcp.json` não precisam mudar.

## Ativação

1. Abra o Codex na raiz deste repositório. A configuração está em
   `.codex/config.toml`; ela usa a raiz como diretório de trabalho do servidor.
   O `cwd` está configurado para esta instalação em `C:\Users\wesml\NEW QA`;
   ajuste esse campo e o caminho do comando em `.codex/hooks.json` se mover
   ou clonar o projeto em outro caminho.
2. Confie no projeto e revise/autorize o hook local quando o cliente solicitar.
   Configurações de projeto e hooks só carregam em projetos confiáveis.
3. Reinicie a sessão para carregar o MCP e as skills em `.agents/skills/`.
   `codex mcp get sanctum` deve mostrar o servidor habilitado, o diretório deste
   projeto e `SANCTUM_CLIENT=codex`. Não use comandos que substituam a configuração
   global do Claude.
4. Para Jira/Confluence, execute `codex mcp login atlassian` e complete o OAuth
   no navegador. A configuração aponta para o mesmo serviço Atlassian, mas a
   autenticação do Codex é independente da sessão do Claude. Não copie tokens.
5. Na nova sessão, confira que `sanctum` oferece `run_status`, `plan_save`,
   `plan_approve`, `browser_open`, `act`, `act_approved`, `verify` e `report_build`,
   e que o Atlassian consegue ler um card autorizado. Isso ainda não executa QA.

Exemplos de pedidos em português:

- `Teste o card PROJ-123` (skill `qa`; invocação explícita: `$qa PROJ-123`).
- `Retome o QA do PROJ-123` (`$qa-resume PROJ-123`).
- `Reteste o PROJ-123 após a correção` (`$retest PROJ-123`).
- `Gere a automação do teste concluído PROJ-123` (`$automate PROJ-123`).

Os nomes `/qa` etc. documentados no README são comandos do Claude; no Codex,
use linguagem natural ou a invocação de skill com `$` suportada pelo cliente.

## Execução dos fluxos

As skills do Codex são adaptadores dos roteiros em `.claude/skills/`; as regras
de planejamento, investigação, classificação, limpeza e fechamento continuam
na fonte original. Ao ler esses roteiros pelo Codex:

- `$ARGUMENTS` significa o card/runId e as opções do pedido atual. Caminhos
  relativos de referências partem do arquivo original que os menciona.
- Descubra as ferramentas pelo servidor e nome da operação: os prefixos
  `mcp__sanctum__...` e nomes Atlassian podem variar entre clientes. Ausência de
  integração deve ser relatada antes de iniciar a execução dependente dela.
- Mostre o plano e espere aprovação explícita antes de `plan_approve`. Uma ação
  RED exige aprovação específica antes de `act_approved`. Ambas estão
  configuradas com `approval_mode = "prompt"`; não configure aprovação automática.
  Além da política do cliente, o servidor iniciado com `SANCTUM_CLIENT=codex`
  solicita confirmação via MCP elicitation form antes de executar essas duas
  ferramentas. Cancelar, recusar ou não oferecer esse recurso bloqueia a operação.
  O cliente precisa permitir elicitações interativas; a confirmação nunca é
  substituída por um booleano fornecido pelo agente na chamada da ferramenta.
- Para lotes regulares, leia `.claude/agents/test-executor.md` como procedimento de
  execução. Para missões e charters exploratórios (`--explore` ou cenários `EXP-*`),
  leia `.claude/agents/test-explorer.md` e aplique as heurísticas sistemáticas.
  Se houver delegação disponível e autorizada, use um executor ou explorador por
  vez com essas instruções, runId e códigos. Caso contrário, execute o mesmo
  ciclo diretamente, consultando `batch_brief` a cada lote; não dependa de um
  tipo de subagente exclusivo do Claude nem opere navegadores concorrentes.
- Na automação, o contexto novo verifica a suficiência de `AUTOMATION.md`.
  Use um subagente isolado quando disponível e autorizado. Sem essa capacidade,
  prepare o spec e peça uma nova sessão Codex com o card e os caminhos do spec
  e dos testes; não declare que houve validação independente na mesma conversa.
  O engenheiro segue `.claude/skills/automate/references/engineer.md` e executa
  somente `automation_run`, inclusive a validação final de estabilidade.
- Publique comentários no Jira apenas se o usuário pedir explicitamente.

## Proteções e limites

O Action Guard, a sanitização, as verificações e as regras de PASSED continuam
no servidor. O hook do Codex adapta o formato da chamada e reutiliza
`.claude/hooks/guard-shell.mjs`, sem modificar o hook do Claude. Ele bloqueia
os comandos diretos de navegador e DELETE reconhecidos pela política existente;
não é uma sandbox completa nem substitui as regras de operação pelo MCP.

Hooks locais exigem suporte e confiança do cliente. Clientes com orquestração
cloud podem não carregar esses hooks nem o MCP stdio local por esta configuração.
Nesses clientes, esta instalação por arquivos não garante as mesmas proteções;
use um cliente Codex local compatível para executar o QA. Não contorne a ausência
do `sanctum` com ferramentas externas de navegador.

Use apenas um cliente por vez neste workspace. Feche o navegador/servidor de um
antes de continuar no outro e consulte `run_status`. A recomendação evita
conflitos, mas não representa um lock global de exclusão mútua implementado.

`SANCTUM_CLIENT=codex` impede a ingestão de transcripts do Claude pelo servidor
Codex. As métricas operacionais continuam funcionando; tokens/custos do Codex
não são importados. Para o CLI `metrics` sob Codex, defina essa mesma variável.
Sem ela, o comportamento do CLI e do MCP do Claude permanece igual.

O `npm run doctor` ainda detecta a configuração Atlassian do Claude; um aviso
nessa checagem não diagnostica o login do Codex. Verifique este pelo cliente MCP.

## Referências da integração

- [Instruções AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Configuração MCP e políticas por ferramenta](https://learn.chatgpt.com/docs/extend/mcp)
- [Hooks: confiança, entradas, bloqueios e limites por cliente](https://learn.chatgpt.com/docs/hooks)
- [Camadas de configuração e caminhos relativos](https://learn.chatgpt.com/docs/config-file/config-advanced)
