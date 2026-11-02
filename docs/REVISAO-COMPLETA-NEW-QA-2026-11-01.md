# Revisão completa do NEW QA

Data: 01/11/2026. Objeto: o projeto NEW QA no estado atual do workspace, incluindo mudanças locais ainda não commitadas. Esta revisão amplia a análise anterior de qualidade e tokens.

## Escopo e validação

Foram examinados os 43 arquivos TypeScript de `src/`, a estrutura e os testes dos 19 arquivos `*.test.ts`, o fixture, configuração, CLI, hooks, adaptadores Codex/Claude, skills e documentação operacional. Relatórios locais foram usados como exemplos das consequências práticas. A leitura de scripts auxiliares foi estática; scripts que operam ambientes reais não foram executados.

| Validação executada | Resultado |
| --- | --- |
| `npm run typecheck` | Passou |
| `npm test` | 163 testes passaram, em 19 arquivos |
| `npm audit --json` | Nenhuma vulnerabilidade conhecida reportada pelo registro npm para o conjunto instalado |
| `npm run metrics -- --schema` | 40 ferramentas; aproximadamente 7.683 tokens de schema pela estimativa caracteres/4 |
| Provas adicionais locais | Executadas com dados sintéticos e SQLite em memória; resultados em `reports/revisao-completa-2026-11-01/probes.json` |

As provas adicionais não abriram navegador, não acessaram o banco operacional, não leram segredos e não enviaram requisições ao app. O resultado de `npm audit` não significa ausência de falhas no código próprio. Não foram executados pentest em ambientes reais, testes de todas as versões suportadas de Node/Windows ou medição percentual de economia em produção.

Não foram implementadas correções no código de produção nesta revisão. Os arquivos novos são esta análise e as provas/artefatos locais. Havia alterações locais de outras atividades; elas não foram revertidas.

## Diagnóstico executivo

A infraestrutura já tem controles valiosos: parâmetros validados, SQLite transacional para operações importantes, evidência obrigatória para falhas, verificação obrigatória para aprovação, redação de várias classes de segredo e testes integrados com fixture.

Os maiores riscos estão nas garantias ao redor desses controles: uma execução pode receber recomendação incompatível com seus cenários; uma automação parcial pode parecer entregue; ações consideradas neutras podem escrever por autosave; e a fronteira de arquivos/URLs não é suficientemente restrita. Na qualidade cotidiana, faltam identidade de critérios, medição visual e distinção formal entre erro do agente e falha do produto.

Gravidade nesta análise: **alta** = pode gerar aprovação indevida, escrita não permitida ou exposição relevante; **média** = compromete confiabilidade, rastreabilidade ou operação em condições específicas. São prioridades propostas da revisão, não severidades atribuídas a bugs do Guruja.

## Achados de gravidade alta

### F01 — O fechamento aceita APROVADO com requisito P0 bloqueado

- **Local:** `src/state/store.ts:187`.
- **Causa:** `completeRun` verifica cenários finalizados e dados pendentes, mas aceita a recomendação fornecida sem confrontá-la com os resultados.
- **Prova:** uma execução sintética em memória com CT-001 P0/BLOCKED foi concluída como COMPLETED/APROVADO. Campo `blockedP0RunCanBeApproved` das provas.
- **Impacto:** o resultado oficial pode contrariar o próprio banco de resultados.
- **Correção:** calcular a recomendação por função central de política; decisões de exceção devem ser explícitas, autorizadas e auditadas, sem fingir PASSED. Manter resultado histórico e resultado vigente separados.
- **Teste faltante:** P0 bloqueado, P1 com bug, decisão de não bug e reclassificação posterior devem produzir a recomendação coerente.

### F02 — Automação pode ser considerada entregue com cobertura incompleta ou execução não íntegra

- **Locais:** `src/mcp/tools/automation.ts:75`, `:89`, `:98`; `src/automation/runner.ts:43–56`.
- **Causas:** o filtro `grep` também é aceito na validação; não existe confronto obrigatório com a lista de cenários aprovados para automação. `allGreen` não exige código de saída zero nem ausência de erros globais. O parser chama de `passed` um grupo com uma repetição aprovada e outra pulada. Também usa `expected`, que no Playwright pode representar uma falha esperada, como aprovação.
- **Prova:** o parser retornou `passed` para pass+skip e para resultado bruto failed marcado como expected. Os demais caminhos foram identificados por inspeção da condição de entrega.
- **Impacto:** `delivered: true` pode não representar todos os cenários realmente aprovados duas vezes.
- **Correção:** manifesto de cenários/versão do spec, conjunto executado idêntico ao obrigatório, duas aprovações reais por teste/projeto, zero skips inesperados, zero bloqueios/erros globais e exitCode=0. Validação filtrada deve ser parcial, nunca entrega completa.
- **Testes faltantes:** grep de um cenário entre vários, erro global no teardown, saída não zero com testes aprovados, repetição pulada e expected-failure.

### F03 — Produção não está protegida de escrita por autosave ou Enter

- **Locais:** `src/guard/classify.ts:11`, `:32`; `src/browser/service.ts:220`, `:503`, `:558`.
- **Causa:** fill/select/check/uncheck/press são tratados como neutros, salvo palavra RED no alvo. A rede bloqueia DELETE, mas permite POST/PUT/PATCH. Em aplicações com autosave ou submit por Enter, essas ações podem persistir dados.
- **Prova:** `check` em um alvo sem palavra de risco recebeu GREEN e foi permitido com ambiente prod/allowDataCreation=false. Não foi efetuada escrita real em produção.
- **Impacto:** a garantia “prod somente leitura” e a exigência de verificação forte para escrita podem ser contornadas pelo comportamento normal da tela, sem botão Salvar.
- **Correção:** política de rede de mutações por ambiente, com exceção estreita e explícita para autenticação. Reconhecer escrita pelo tráfego e não só pela intenção lexical. Compatibilizar com autosave e endpoints cuja leitura usa POST, quando documentados.
- **Testes faltantes:** checkbox com autosave PUT, campo com autosave POST e Enter que envia formulário em prod.

### F04 — Upload permite escapar da pasta do projeto e não protege arquivos sensíveis

- **Local:** `src/browser/service.ts:601–604`.
- **Causa:** `join(rootDir, f)` e existência não asseguram que o caminho resolvido permanece dentro de uma pasta autorizada. `../arquivo` pode sair da raiz; mesmo dentro da raiz, arquivos como configuração sensível não têm uma política específica de exclusão.
- **Prova:** a resolução de `../audit-dummy.txt` aponta para fora do workspace. Nenhum arquivo externo foi lido ou enviado.
- **Impacto:** uma solicitação de upload pode enviar arquivo local fora do conjunto de evidências autorizado.
- **Correção:** resolver caminho real, validar contenção após normalização e symlinks/junctions, restringir uploads a uma pasta de artefatos e bloquear arquivos de credenciais/configuração por padrão.
- **Testes faltantes:** `..`, caminhos absolutos, symlink/junction e arquivo sensível dentro da raiz.

### F05 — Override de URL pode contrariar a proteção de produção da automação

- **Local:** `src/automation/scaffold.ts:39–49`.
- **Causa:** a proteção verifica `env.type`, mas `baseURL()` aceita `NOVO_QA_BASE_URL` livre depois dessa decisão.
- **Evidência:** inspeção estática do código gerado. O override é propagado do ambiente do processo pelo runner.
- **Impacto:** uma seleção de ambiente dev pode executar a suíte contra outra origem, inclusive uma origem de produção, se o override for definido incorretamente.
- **Correção:** validar origem final contra ambiente/allowlist; override apenas de teste controlado pelo servidor ou restrito a fixture local. Considerar ainda URLs absolutas nos testes, que não usam baseURL.
- **Teste faltante:** env dev com override apontando para origem não autorizada deve falhar antes da primeira request.

### F06 — Automação pode usar um run antigo aprovado após regressão em run mais recente

- **Locais:** `src/mcp/tools/automation.ts:20–28`; `src/automation/spec.ts:70`.
- **Causa:** `sourceRun` procura o último run que tenha `automation_approved=1`; um reteste mais recente com falha, sem avaliação de automação, pode ser ignorado. O spec seleciona pelos flags sem conferir novamente a validade vigente de todos os cenários.
- **Evidência:** inspeção da consulta e da seleção de cenários.
- **Impacto:** automatizar comportamento obsoleto como se ainda estivesse validado.
- **Correção:** origem explícita e imutável do spec, vinculada à revisão de cenário/critério/build; invalidar elegibilidade quando um resultado posterior contradiz o anterior. Não escolher silenciosamente um run antigo.
- **Teste faltante:** manual aprovado e avaliado para automação, seguido de reteste com a mesma funcionalidade FAILED; a geração deve ser bloqueada ou exigir escolha explícita e justificativa.

### F07 — Limpeza não garante ausência do dado nem restringe suficientemente o destino

- **Locais:** `src/state/cleanup.ts:8–20`; `src/browser/service.ts:624–652`.
- **Causas:** `expectStatus: '200'` pode ser a única condição de verificação; a resposta 200 do recurso ainda existente então confirma a limpeza. Caminhos que começam com `//` passam no schema, embora sejam referências a outra origem na resolução de URL. A vinculação entre recurso criado e rota de limpeza não é comprovada estruturalmente.
- **Provas:** o schema aceitou verificação apenas de 200 e caminhos `//untrusted.invalid/item`. Nenhuma exclusão foi executada nessas provas.
- **Impacto:** dado não removido pode ser marcado VERIFIED; uma especificação de limpeza incorreta pode atingir recurso fora da intenção do run.
- **Correção:** pós-condição de ausência explícita (404 ou asserção estrutural), origem permitida e correlação com o recurso/ID registrado. Separar restauração de edição de exclusão de criação.
- **Testes faltantes:** DELETE sem efeito com GET 200, caminho com `//`, ID diferente do registrado e atualização que precisa restaurar estado anterior.

## Achados de gravidade média

### F08 — Segredo desconhecido composto de letras minúsculas pode escapar da redação textual

- **Local:** `src/security/redact.ts:98–103`.
- **Causa:** valores sem aspas apenas em minúsculas são preservados para evitar redigir prosa. Isso também preserva credenciais em texto livre ou URL.
- **Prova:** `new Redactor().text('token=syntheticlowercase')` devolveu o mesmo conteúdo. Segredos conhecidos do SecretStore podem ser protegidos pela substituição exata; o problema é o valor não conhecido previamente.
- **Correção:** tratar chaves fortes de credencial, especialmente em URL/header/JSON, sem a exceção de prosa. Testar valores curtos, codificados e rotacionados.

### F09 — Navegação e injeção de credenciais não estão limitadas à origem autorizada

- **Locais:** `src/browser/service.ts:381`, `:518`; `src/browser/values.ts`.
- **Causa:** navegar para URL absoluta é permitido e referências de segredo são resolvidas sem validar a origem atual do formulário.
- **Evidência:** inspeção estática. Não foi enviado segredo para destino externo.
- **Impacto:** um erro de navegação, redirecionamento ou instrução não confiável da página pode levar credenciais do ambiente a um formulário fora do escopo.
- **Correção:** origens de leitura e de autenticação separadas, validação da origem no momento de inserir segredo e tratamento explícito de provedores SSO/Figma aprovados. Não bloquear indiscriminadamente integrações legítimas.

### F10 — Recarregar configuração não atualiza o ambiente capturado pela sessão aberta

- **Locais:** `src/config/runtime.ts:17–21`; `src/browser/service.ts:182`, `:503`, `:518`, `:624`.
- **Causa:** o reload substitui o dicionário de ambientes, mas a sessão mantém a referência ao objeto antigo. Guard e referências de credenciais usam esse objeto capturado.
- **Impacto:** mudanças em allowDataCreation, tipo de ambiente, papéis ou senha referenciada podem não valer para o navegador já aberto.
- **Correção:** snapshot de configuração com versão e invalidação/validação da sessão ao recarregar; ou resolver ambiente vigente com contrato explícito. Não mudar a origem de uma sessão autenticada silenciosamente.

### F11 — Alterações por PUT/PATCH e efeitos tardios não entram automaticamente na limpeza

- **Local:** `src/browser/service.ts:558–563`.
- **Causa:** apenas POST 2xx associado a ação não GREEN vira candidato. Atualizações e autosaves podem não ser registrados.
- **Impacto:** poluição de massa e ausência de estado anterior para restauração. Na execução acompanhada, seis alterações precisaram ser registradas manualmente.
- **Correção:** diário de mutações com método, entidade, before/after, janela causal e política de manutenção/restauração; não considerar todo POST uma criação, pois pode ser leitura ou login.

### F12 — O spec de automação perde partes importantes das verificações manuais

- **Locais:** `src/automation/spec.ts:47–58`, `:76`.
- **Causa:** a asserção de rede não reproduz `requestBodyContains`; API GET gerada não representa a captura de Authorization usada pela verificação manual; o contexto usa o último papel aberto do run como papel geral.
- **Prova:** uma verificação PUT com payload esperado gerou código sem a asserção desse payload. Autenticação e papéis foram constatados por leitura do código.
- **Impacto:** automação mais fraca que o manual ou falhando por lacuna do spec em runs com vários papéis.
- **Correção:** preservar todas as condições por check, marcar placeholders que exigem implementação, vincular cada ação/cenário ao papel e não entregar enquanto houver lacunas obrigatórias.

### F13 — Ações podem ser aprendidas como validadas por uma checagem sem relação com seu efeito

- **Locais:** `src/state/store.ts:573`; `src/knowledge/execution.ts:113–120`.
- **Causa:** basta qualquer verify positivo posterior no cenário; não há relação explícita ação→asserção e a consulta não limita a tentativa atual. As dicas são as primeiras 40 entradas, sem ranking.
- **Impacto:** conhecimento cresce com ações incidentais, tentativas antigas ou seletores de pouca utilidade, aumentando erros e tokens futuros.
- **Correção:** relação com check/tentativa, deduplicação por finalidade, ranking por rota/papel/sucesso recente e expiração/depreciação.

### F14 — Identidade do reteste e conclusão histórica continuam incompletas

- **Locais:** `src/reporting/report.ts:43–104`; `src/state/store.ts:362`.
- **Causa:** associação principalmente por código CT; resultado atual ajustado e recomendação histórica são exibidos juntos. A proteção de reclassificação posterior já adicionada resolve a precedência temporal, não a troca de comportamento sob o mesmo código.
- **Impacto:** botão de informação aprovado pode aparecer como correção do tooltip; retirada/restauração de um bug deixa textos de conclusão antigos.
- **Correção:** identidade estável, revisão do critério e `retestOf`; avaliação vigente calculada e claramente separada do snapshot no fechamento. Usar “passou no reteste” em vez de inferir correção de código.

### F15 — Verificações não demonstram cobertura integral e confundem erro de execução com falha funcional

- **Locais:** `src/state/rules.ts:78–130`; `src/browser/service.ts:735–777`.
- **Causas:** aprovação pode depender de uma única verificação; repetição é identificada por texto da descrição; ambiguidade/ausência de alvo pode resultar em falso sem identificar se o teste apontou o elemento certo. Para algumas condições, qualquer elemento correspondente visível/textual basta.
- **Prova:** o avaliador aceitou um cenário P1 com uma única checagem de cabeçalho. Isso comprova o limite da política, não que o avaliador conheça e ignore um requisito específico.
- **Correção:** checkId, cobertura de condições obrigatórias e estados distintos para erro de execução, asserção reprovada e não avaliado. Manter falhas antigas rastreáveis, sem obrigar repetir uma frase para substituí-las.

### F16 — Métricas podem atribuir uso incorreto e omitir chamadas de navegador

- **Locais:** `src/metrics/run-metrics.ts:12–76`; `src/mcp/tooling.ts:35–36`; `src/metrics/transcripts.ts:106–109`.
- **Causa:** atribuição temporal por sessão, filtro com prefixo específico e consultas de cache apenas por janela. Muitas ferramentas não levam runId e seus eventos de ferramenta ficam sem essa associação. A ingestão relê arquivos completos a cada relatório. O Codex não tem contador de tokens próprio implementado.
- **Impacto:** custo por cenário/card e comparação entre clientes não são suficientemente confiáveis; relatórios repetidos têm custo local crescente.
- **Correção:** IDs explícitos de cliente/sessão/agente/run/cenário/tentativa/chamada, normalização de nomes, distinção entre indisponível e zero e ingestão incremental. Separar tempo ativo de espera humana.

### F17 — Concorrência e encerramento podem afetar outro run ou deixar finalização incompleta

- **Locais:** `src/browser/service.ts:262–269`, `:342–344`; `src/mcp/tools/state.ts:53–57`; `src/state/store.ts:131–153`.
- **Causas:** arquivo de PID não é exclusão mútua; fechar um run chama close no navegador do servidor sem verificar proprietário do browser. A validação de run ativo e inserção não são uma única operação protegida por índice de unicidade. O estado COMPLETED é gravado antes de exportar conhecimento e fechar recursos.
- **Impacto:** clientes concorrentes podem sobrescrever a trava ou fechar sessão de outro card; falha de exportação após o commit deixa operação sem finalização reexecutável.
- **Correção:** lease/lock com proprietário, close condicionado ao run e finalização idempotente com fase recuperável. Restrição transacional de run ativo. Atender a regra operacional de um cliente por vez continua necessário até haver exclusão efetiva.

### F18 — Metadados de sanitização e validação final do relatório são excessivamente otimistas

- **Locais:** `src/state/store.ts:485`; `src/security/trace.ts:12–28`; `src/reporting/report.ts:126`, `:306`; `.claude/skills/qa/references/execute-and-close.md`.
- **Causas:** evidências recebem `sanitized=1` de forma genérica, embora vídeo/binários não passem pela redação textual. Máscaras de screenshot são seletivas. O código gera relatório com `missingSummaries`, em vez de impedir sua entrega incompleta. Etapas numeradas com quebras de linha são escapadas em `dd`, sem estrutura de lista no HTML.
- **Impacto:** quem exporta evidências pode acreditar que todo seu conteúdo foi sanitizado; relatórios ficam incompletos ou difíceis de reproduzir apesar da regra nas skills.
- **Correção:** registrar política realmente aplicada por tipo de evidência, não um booleano genérico; revisar conteúdo antes de compartilhamento. Criar fase de relatório final validado, com resumos obrigatórios, links existentes, UTF-8 e passos estruturados.

## Cobertura por subsistema e pontos adicionais

| Subsistema | Avaliação |
| --- | --- |
| Estado e SQLite | Migrações com transação, WAL e busy timeout são bons fundamentos. F01, F14 e F17 são os principais riscos. Adicionar testes de recuperação de finalização e migração entre versões. |
| Navegador, snapshots e alvos | Alvos semânticos e diffs reduzem ruído. F03, F04, F09–F11 e F15 precisam de atenção. Adicionar medição geométrica segura com viewport/escala/build registrados. |
| Guard e aprovação | As aprovações e testes de elicitation existem. A política lexical não substitui restrição de mutações na rede. Não remover aprovações para economizar tokens. |
| Segredos, traces e evidências | Substituição exata, headers e ZIP textual têm testes. F08/F18 e retenção/permissões de `.auth`, vídeos e traces merecem reforço. |
| Limpeza de dados | Há bloqueio de conclusão para itens pendentes, mas F07/F11 comprometem a garantia real. |
| Automação | Sem retries por padrão e repetição são boas decisões; F02/F05/F06/F12 limitam a confiança de entrega. Acrescentar manejo de erro de spawn e encerramento da árvore de processos em timeout. |
| Configuração e doctor | Schemas estritos e senhas via env são bons. F10 permanece; doctor ainda verifica principalmente configuração Atlassian do Claude, não a sessão efetiva do Codex. Validar URL final e fornecer diagnóstico por cliente. |
| MCP e launcher | Reload com fila e aviso de mudança de ferramentas é útil. Rever timeout de 120s de inflight diante de aprovações humanas demoradas; adicionar rastreamento e cancelamento sem perder estado. |
| Cache, contexto e conhecimento | Proveniência e cache versionado são positivos. A verificação de stale compara com a versão disponível em cache, não prova atualização da origem remota; mudanças na fonte individual de cada statement também precisam ser consideradas. Escritas de cache/knowledge precisam ser atômicas para evitar arquivo truncado. |
| Relatórios HTML/Markdown | Escape de texto e links relativos são positivos. F14/F18 são prioritários; distinguir sucesso observado, aceitação de requisito e confirmação de correção de código. |
| Métricas e tokens | F16 deve ser resolvido antes de atribuir custo ao Codex ou calcular retorno das otimizações. |
| CLI, hooks e documentação | Os hooks são heurísticos e não uma sandbox. Scripts auxiliares ad hoc encontrados na raiz devem ser inventariados e excluídos do caminho normal de QA; não executar operações reais por outra rota de cliente para evitar confirmações. Documentação cita recursos opcionais ainda ausentes, como bug-investigator. |
| Testes e manutenção | 163 testes verdes são um bom baseline, mas as provas encontraram regras ausentes. Não foi encontrada configuração de CI em `.github` no workspace examinado; recomendar execução automatizada em PR e Windows/Node suportados. Não foi medido percentual de cobertura de linhas/branches. |

## Plano para qualidade dos testes

1. Bloquear aprovação indevida e entrega parcial antes de ampliar a quantidade de testes.
2. Adicionar regressões para cada prova acima: resultado incompatível, skipped repeat, expected failure, payload perdido, caminho inválido e segredo textual.
3. No fixture, acrescentar autosave por checkbox/fill/Enter, sessão derrubada, dois clientes e DELETE sem efeito. Executar apenas contra fixture local.
4. Versionar critérios e decisões: obrigatório versus exemplo, tolerância visual, massa autorizada e resolução do achado.
5. Medir layout pelo servidor com operações fechadas: bounding box, estilos computados, truncamento e sobreposição. Nenhuma avaliação JS arbitrária exposta ao modelo.
6. Incluir build/commit do alvo quando disponível, papel, viewport e fonte do esperado em toda evidência visual.
7. Tratar erro do agente como erro do teste e medir sua frequência, em vez de diluir tudo em FAILED/NEEDS_REVIEW.

## Plano para reduzir tokens e tempo

### Contexto

- Novo executor por lote, com contexto limpo. Na execução desta conversa houve herança extensa e retomadas do mesmo agente, contrariando o objetivo do desenho D4.
- Briefing apenas com critérios e decisões do lote, massa útil e seletores relevantes por rota/papel/recência.
- Pré-condições compartilhadas no nível do lote; não repetir parágrafos iguais em cada cenário.
- Regenerar resumos por código, enviando somente o que mudou.

### Chamadas

- `fill_form` e `verify_many` com operações limitadas e rastreáveis; guard por ação, interrupção no primeiro erro e nenhuma autorização RED implícita.
- Projeção segura de JSON/entidades e arquivos de evidência sanitizados, em vez de corpos inteiros ou cortes sem acesso ao trecho necessário.
- Retornar progresso por evento para reduzir consultas repetidas de run_status.
- Orçamento de tentativas de seletor e investigação por cenário, com checkpoint e hipótese ao atingir o limite.

### Schemas

O catálogo medido tem **40 ferramentas e ~7.683 tokens**, pela aproximação caracteres/4. `verify`, `data_register`, `report_build`, `act` e `act_approved` estão entre as maiores. Isso não significa que o cliente envie todos esses tokens em toda chamada: carregamento diferido e cache variam por cliente.

Reduzir descrições redundantes, manter referências reutilizáveis e, quando o cliente permitir, expor o conjunto pertinente à etapa. Não empobrecer o schema a ponto de gerar mais erros de chamada. Medir com o tokenizer/modelo efetivo antes de estimar economia financeira.

### Massa e memória

- Catálogo de contas por capacidade (meta longa, reforços, aprofundamentos, desempenho editável), sem senhas no conhecimento.
- Reutilizar uma preparação válida nas telas relacionadas, como a massa real de cores preparada no GURUJA-9233.
- Não aprender automaticamente uma ação só porque outra checagem posterior passou.
- Revisão e depreciação do knowledge para não carregar indefinidamente passos de baixo valor.

## Ordem recomendada de trabalho

1. **Segurança e aprovação:** F01–F07, antes de usar a ferramenta como garantia forte de leitura em produção ou entrega automática.
2. **Confiabilidade:** F12–F15 e F17; identidade, critérios, sessão e recuperação.
3. **Medição:** F16, para ter baseline honesto de custo e tempo.
4. **Experiência operacional:** medição visual, massa reutilizável, contexto limpo e operações compostas.
5. **Entrega e manutenção:** F08–F11/F18, CI, relatório final e políticas de retenção/origem. Os controles de segredo e origem devem avançar junto da primeira etapa quando houver dados sensíveis.

Executar em mudanças pequenas: corrigir uma garantia, adicionar o teste que falhava e rodar typecheck + testes pertinentes. Antes/depois devem ser comparados em cards de risco equivalente, com o mesmo build e massa compatível.

## Indicadores de sucesso

- Nenhuma aprovação com critério obrigatório falho ou bloqueado sem decisão autorizada explícita.
- Nenhuma entrega de automação com subconjunto, repetição faltante, erro global ou saída não zero.
- Nenhuma mutação de produção fora de exceção estreita de autenticação.
- Taxa de falsos bugs e de erros de seletor por cenário.
- Cobertura de critérios obrigatórios, persistência de escrita e integridade das evidências.
- Tokens novos/cache/saída separados, chamadas por cenário, tamanho de briefing, tempo ativo e espera humana.
- Redução de tokens e tempo sem queda desses indicadores de qualidade. Não há porcentagem de economia comprovada nesta revisão.

## Artefatos de reprodução

- `reports/revisao-completa-2026-11-01/probes.ts`: provas locais, sem aplicação real.
- `reports/revisao-completa-2026-11-01/probes.json`: resultados observados dessas provas.
- `reports/revisao-completa-2026-11-01/npm-audit.json`: resultado do registro npm nesta revisão.
- `docs/ANALISE-QUALIDADE-TOKENS-2026-11-01.md`: análise anterior, mais focada no fluxo de QA e no consumo de contexto.
