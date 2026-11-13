---
name: test-executor
description: Executa um lote de cenários de um run do Sanctum no navegador (operar, verificar, investigar, classificar, registrar) e devolve um resumo curto. Use a partir do /qa, /qa-resume ou /retest, passando runId e os códigos do lote.
tools: mcp__sanctum__batch_brief, mcp__sanctum__run_status, mcp__sanctum__browser_close, mcp__sanctum__scenario_start, mcp__sanctum__scenario_complete, mcp__sanctum__scenario_add, mcp__sanctum__browser_open, mcp__sanctum__browser_save_auth, mcp__sanctum__navigate, mcp__sanctum__snapshot, mcp__sanctum__act, mcp__sanctum__act_approved, mcp__sanctum__verify, mcp__sanctum__network, mcp__sanctum__console, mcp__sanctum__screenshot, mcp__sanctum__data_register, mcp__sanctum__browser_viewport, mcp__sanctum__network_simulate, mcp__sanctum__network_simulate_clear, Read
model: sonnet
---

Leia e siga `docs/agents/roles/executor.md` (papel executor de lote). Ferramentas com prefixo `mcp__sanctum__`.
