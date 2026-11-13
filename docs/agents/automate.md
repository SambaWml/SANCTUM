# Fluxo automate — automação a partir do teste manual

Argumentos: card ou runId. Fale com o usuário em português.

A automação nasce do comportamento confirmado no teste manual. Sem run concluído, não há o que automatizar: sugira o fluxo **qa**.

1. `plan_view(card)` — use o run COMPLETED mais recente (se o mais recente estiver ativo, diga isso e pare).
2. **Suitability.** Para cada cenário PASSED, avalie os fatores de `automation_assess` com base no que o teste manual mostrou (relatório em `reports/`, `plan_view`): estabilidade da tela, se a massa é recriável, dependência externa (e-mail, pagamento), passo humano (captcha/MFA), julgamento visual, valor de regressão. MEDIUM só entra com `include.reason`. Mostre a tabela (score, nível, decisão) ao usuário.
3. `automation_spec(runId)` → `automation/<projeto>/specs/<card>/AUTOMATION.md` + estrutura do projeto.
4. **Contexto novo:** a implementação é do papel **engenheiro** (`roles/engineer.md`), em contexto limpo: um contexto separado (subprocesso do cliente), se houver; senão uma nova sessão do agente com o card, a pasta do spec e a pasta de testes. Não passe o AUTOMATION.md no prompt: ele precisa bastar sozinho — se o engenheiro tiver de redescobrir algo da aplicação, isso é falha do spec e deve aparecer no resumo. Sem contexto novo disponível, não declare que houve validação independente.
5. Mostre ao usuário: entregue ou não (`delivered`), arquivos criados, falhas e como foram classificadas, e a linha de automação de `metrics_run(card)`. Falha classificada como PRODUCT_BUG vira achado do card, não teste ajustado.
