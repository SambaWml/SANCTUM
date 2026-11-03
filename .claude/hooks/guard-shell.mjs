// PreToolUse (Bash/PowerShell): impede operar o navegador ou fazer DELETE HTTP por fora
// das ferramentas do MCP novo-qa, o que contornaria o Action Guard.
// Saída 2 bloqueia a chamada; a mensagem vai para o Claude.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Proteção de boa-fé, não fronteira de segurança: barra os contornos óbvios do Action Guard.
const BROWSER = /\b(playwright|puppeteer|chromium|selenium|webdriver)\b/i;
// Interpretador em qualquer forma: caminho, aspas, .exe (node.exe, "C:/.../node").
const INTERPRETER = /(^|[\s;&|("'`\\/])(node|tsx|python3?|py|deno|bun|npx)(\.exe)?["']?(\s|$)/i;
// Escrita HTTP direta (DELETE/PUT/PATCH) por cliente de linha de comando, em qualquer grafia de flag.
const HTTP_WRITE = /(curl|wget|http|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n]*(-X\s*(DELETE|PUT|PATCH)\b|--request[=\s]+(DELETE|PUT|PATCH)\b|-Method[:\s]+(Delete|Put|Patch)\b)/i;
// Escrita HTTP em código inline (node -e "fetch(..., {method:'DELETE'})", python -c "requests.delete(...)").
const INLINE_WRITE = /(method\s*:\s*['"](DELETE|PUT|PATCH)['"]|requests\.(delete|put|patch)\s*\()/i;

// Usos legítimos: rodar a suíte de automação/testes e gerenciar o Playwright. O trecho permitido
// para em ; & | nova linha, $( e crase — nada encadeado escapa junto. --config só de automation/.
const SAFE_ARGS = '[^;&|\\n`$]*';
const ALLOWED = [
  new RegExp(`npx\\s+playwright\\s+test\\b(?!${SAFE_ARGS}\\s(?:--config|-c)(?:=|\\s+)(?!["']?automation[\\\\/]))${SAFE_ARGS}`, 'gi'),
  new RegExp(`npx\\s+playwright\\s+(install|show-trace|show-report|codegen\\s+--help)\\b${SAFE_ARGS}`, 'gi'),
  new RegExp(`npx\\s+vitest\\b${SAFE_ARGS}`, 'gi'),
];

const INTERPRETERS = new Set(['node', 'tsx', 'deno', 'bun', 'python', 'python3', 'py']);
const SCRIPT_EXT = /\.(?:m?js|cjs|ts|py)$/;

/**
 * Arquivos que um interpretador vai EXECUTAR: em cada trecho do comando, o primeiro arquivo
 * de script depois de node/tsx/… (pulando flags). Arquivo só citado (sed, cat, tsc) não conta.
 */
function executedScripts(command) {
  const out = [];
  for (const segment of command.split(/[;&|\n]+/)) {
    const tokens = segment.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
    const at = tokens.findIndex((t) => INTERPRETERS.has(t.split(/[\\/]/).pop().replace(/\.exe$/i, '')));
    if (at === -1) continue;
    const file = tokens.slice(at + 1).find((t) => SCRIPT_EXT.test(t));
    if (file) out.push(file);
  }
  return out;
}

export function check(command, cwd = process.cwd()) {
  if (HTTP_WRITE.test(command)) {
    return 'DELETE/PUT/PATCH HTTP direto contorna o Action Guard. Alterações passam pelo navegador (act/act_approved); limpeza de dados do teste, por cleanup_run.';
  }
  let residual = command;
  for (const re of ALLOWED) residual = residual.replace(re, ' ');
  if (!INTERPRETER.test(residual)) return null;
  if (INLINE_WRITE.test(residual)) {
    return 'Escrita HTTP (DELETE/PUT/PATCH) em código inline contorna o Action Guard. Use act_approved ou cleanup_run.';
  }

  if (BROWSER.test(residual)) {
    return 'Operar o navegador por script contorna o Action Guard e a sanitização. Use as ferramentas do MCP novo-qa (navigate, act, verify…). Para automação gerada: npx playwright test.';
  }
  for (const file of executedScripts(residual)) {
    const path = isAbsolute(file) ? file : join(cwd, file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    if (/(require\(|from\s+|import\()\s*['"](playwright|@playwright\/test|puppeteer|playwright-core)['"]/.test(source)) {
      return `${file} importa um driver de navegador: execute-o como teste (npx playwright test) ou use as ferramentas do MCP novo-qa.`;
    }
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return;
  const reason = check(command, input.cwd ?? process.cwd());
  if (reason) {
    process.stderr.write(`NOVO QA guard: ${reason}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
