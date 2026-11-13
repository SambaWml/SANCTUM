<p align="center">
  <img src="src/live/sanctum-logo.png" alt="SANCTUM Logo" width="128" height="128">
</p>

<h1 align="center">SANCTUM</h1>

<p align="center">
  <b>Agente local de QA operado por IA, com verificação obrigatória e aprovação humana</b><br>
  <i>Planeja por risco, executa no navegador, explora, prova cada resultado e entrega relatório com evidência.</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22%20%7C%2024-00e599?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Playwright-Chromium-f6bd41?style=for-the-badge&logo=playwright&logoColor=black" alt="Playwright">
  <img src="https://img.shields.io/badge/TypeScript-ESM-3b82f6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/MCP-Server-a855f7?style=for-the-badge" alt="MCP Server">
</p>

---

## O que é o Sanctum

O **Sanctum** é um agente e orquestrador local de QA que roda integrado a ferramentas de IA (**Claude Code**, **Antigravity** e **Codex local**).

* **Os agentes testam:** leem o card, planejam por risco, operam o navegador, conferem rede e console, exploram em sessões com foco e prazo e registram cada achado com evidência.
* **Você decide:** nenhum plano é executado e nenhuma ação de risco acontece sem a sua aprovação.
* **Painel de operação** (`http://127.0.0.1:4777`): indicadores do período, decisões pendentes, missões em andamento e resultados de cada card.

---

## Regras que o código garante

1. **Nenhum PASSED Sem Prova:** Um cenário de teste só pode ser marcado como `PASSED` se uma asserção for fisicamente executada e registrada pela ferramenta `verify`. Sem verificação, a aprovação é rejeitada pelo núcleo.
2. **Action Guard & Proteção de Produção:** Ações de risco (*RED*, como pagamentos, exclusões e mutações de banco) são retidas pelo guardião até a autorização explícita do usuário. Em ambientes do tipo `prod`, mutações de escrita são permanentemente bloqueadas.
3. **Segredos Nunca Vazados:** Senhas e tokens residem exclusivamente no `.env` local e são referenciados apenas por alias (`secret:NOME` ou `role:usuario.password`). Toda e qualquer saída (terminal, prints, logs e relatórios) passa pelo sanitizador de redação.
4. **Isolamento Total:** Todo o banco SQLite (`data/sanctum.db`), vídeos, capturas de tela e relatórios gerados permanecem 100% locais na sua máquina, fora do git.

---

## 📋 Pré-Requisitos

Antes de iniciar, certifique-se de possuir em sua máquina:

* **Node.js:** Versão `>= 22.13` (testado e homologado no Node 22 e 24).
* **Git:** Para versionamento e clone do repositório.
* **Navegador para Automação:** Chromium gerenciado pelo Playwright.
* **Agente de IA Suportado:**
  * [Claude Code](https://claude.com/claude-code) (CLI, extensão do VS Code ou Desktop)
  * [Google Antigravity](https://antigravity.google) (com suporte nativo a MCP)
  * [Codex local](docs/agents/clients/codex.md)

Todo agente segue o mesmo roteiro: as regras estão em [AGENTS.md](AGENTS.md) e em [docs/agents/](docs/agents/); os arquivos em `.claude/`, `.agents/` e `.codex/` são só adaptadores. O que muda por cliente está em `docs/agents/clients/`.
* **Jira / Confluence:** Atlassian MCP conectado ao seu cliente de IA ou TWG local para leitura direta de cards.

---

## 🚀 Instalação Passo a Passo

### 1. Clonar o Repositório e Instalar Dependências
```bash
git clone https://github.com/SambaWml/SANCTUM.git
cd SANCTUM
npm install
```

### 2. Instalar os Binários do Navegador Playwright
```bash
npx playwright install chromium
```

### 3. Configurar as Variáveis de Ambiente (`.env`)
Copie o arquivo de exemplo e defina suas credenciais locais:
```bash
cp .env.example .env
```
Abra o `.env` no seu editor e configure as chaves necessárias:
```ini
# Site do Jira (links do painel). O card é lido pelo Atlassian MCP do seu agente.
SANCTUM_JIRA_URL=https://seu-dominio.atlassian.net

# Senhas dos Ambientes de Teste (NUNCA coloque no YAML nem no chat)
# Dica: Use aspas simples caso a senha contenha '#' ou caracteres especiais
LOJA_HML_ADMIN_PASSWORD='senha_do_admin'
LOJA_HML_CLIENTE_PASSWORD='senha_do_cliente'
```

### 4. Diagnosticar a instalação
Execute o verificador do sistema para garantir que tudo está pronto:
```bash
npm run doctor
```
Se tudo estiver correto, o doutor validará Node.js, dependências, Playwright, arquivos de configuração e credenciais.

---

## Painel de operação

```bash
npm run live
```
Abra **`http://127.0.0.1:4777`**.

* **Indicadores do período** (hoje, 7 ou 30 dias): cards testados, bugs confirmados (e quantos viraram card no Jira), aprovados de primeira, tempo médio por card, cobertura dos critérios de aceite e consumo do Claude. Tudo calculado dos testes registrados; nada estimado.
* **Precisa de você:** uma fila única com o que trava os agentes — plano para aprovar, permissão de ação de risco, perguntas do modo descoberta, agente esperando resposta, missão que parou e run sem ninguém operando.
* **Em andamento:** etapa de cada missão e um bloco por cenário (passou, falhou, em revisão).
* **Resultados:** veredito de cada card, bugs com link do Jira, duração, relatório e reteste.
* **Agentes e limites**, módulos que mais falham e o conhecimento que espera revisão.
* **Nova missão** pela tela (Claude ou Antigravity) e conversa com o agente sem sair do painel.

---

## Comandos no agente

Dentro do seu agente de IA (Claude Code, Antigravity ou Codex), no diretório do projeto:

| Comando | O que faz |
| :--- | :--- |
| `/qa CARD-123` | lê o card no Jira, monta o plano por risco, espera a sua aprovação, executa no navegador e gera relatório com evidências. |
| `/qa CARD-123 --explore` | o mesmo fluxo com sessões exploratórias (charters) em volta do risco. Com uma URL no lugar do card, entra em modo descoberta: mapeia o sistema, pergunta o que não dá para deduzir e só então planeja. |
| `/qa CARD-123 --automate` | ao final da execução manual bem-sucedida, gera e valida testes automatizados Playwright. |
| `/qa-resume CARD-123` | retoma um teste interrompido de onde parou. |
| `/retest CARD-123` | retesta apenas os cenários que falharam no ciclo anterior e compara os resultados. |
| `/analisar CARD-123` | analisa a US antes do teste — lacunas por critério, perguntas ao PO, riscos, melhorias na funcionalidade e rascunho de cenários. Não testa nem publica no Jira. |
| `/automate CARD-123` | transforma passos e evidências de um teste manual anterior em suite Playwright. |

---

## ⚙️ Configuração de Ambientes & Projetos

Os arquivos de configuração ficam na pasta `config/`:

* **`config/environments.yaml`** / **`config/projects.yaml`**: versionados, só com o que é da própria ferramenta (app fixture e painel).
* **`config/environments.local.yaml`** / **`config/projects.local.yaml`**: os sistemas que **você** testa — fora do git (URLs e usuários de cliente não vão para o repositório). O Sanctum lê o local por cima do base. O jeito mais fácil de cadastrar é pedir ao agente (`env_register`: só acrescenta e deixa a criação de dados desligada). Senhas **sempre** referenciam variáveis do `.env`:
  ```yaml
  # config/environments.local.yaml
  environments:
    loja-hml:
      project: loja
      type: staging
      baseUrl: https://hml.loja.exemplo.com
      allowDataCreation: false   # liberar criação de dados é decisão sua
      roles:
        admin:
          username: qa.admin
          password: { env: LOJA_HML_ADMIN_PASSWORD }
  ```
  ```yaml
  # config/projects.local.yaml
  projects:
    loja:
      name: Loja Online
      jiraKeys: [LOJA]
      language: pt
  ```
* **`config/qa-policy.yaml`**: Definição de regras de risco (ações GREEN vs RED), exigências de evidência e tolerância de anomalias.

---

## 🛠️ Comandos de Desenvolvimento & Auditoria

```bash
# Executa a suite de testes automatizados (Vitest)
npm test

# Validação estática de tipos TypeScript
npm run typecheck

# Diagnóstico de integridade do ambiente e configurações
npm run doctor

# Sobe aplicação fixture local (porta 4400) para testes de ferramentas
npm run fixture

```

---

## 📂 Estrutura do Repositório

```text
SANCTUM/
├── config/                  # Ambientes, projetos e política de segurança de QA
│   ├── environments.yaml    # Ambientes da ferramenta (+ environments.local.yaml, seus, gitignored)
│   ├── projects.yaml        # Projetos da ferramenta (+ projects.local.yaml, seus, gitignored)
│   └── qa-policy.yaml       # Classificação de ações de risco (RED vs GREEN)
├── data/                    # Banco SQLite compartilhado (data/sanctum.db, gitignored)
├── docs/                    # Arquitetura, guias do Codex e decisões técnicas
├── knowledge/               # Conhecimento por projeto (gerado ao testar; o dos seus sistemas fica fora do git)
├── reports/                 # Relatórios HTML e Markdown gerados por card (gitignored)
├── runs/                    # Evidências: vídeos, screenshots, traces de rede (gitignored)
├── src/
│   ├── browser/             # Sessão Playwright, observadores de rede e console
│   ├── guard/               # Action Guard (salvaguarda de ações perigosas)
│   ├── live/                # Servidor do painel de operação
│   │   ├── panel.html       # Painel de operação
│   │   ├── server.ts        # Servidor HTTP local (127.0.0.1:4777)
│   │   └── state.ts         # Cálculo de métricas, bestiário e 20 glórias multi-tier
│   ├── mcp/                 # Servidor MCP expondo as ferramentas para os agentes de IA
│   ├── security/            # Sanitização de dados, mascaramento de senhas e redação
│   └── state/               # Persistência em SQLite e regras de verificação
└── test/                    # Suite de testes unitários e de integração
```

---

<p align="center">
  <b>Sanctum</b> · agente local de QA
</p>
