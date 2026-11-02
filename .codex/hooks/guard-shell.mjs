// Adapta as entradas do Codex e reutiliza a política existente do Claude.
import { pathToFileURL } from 'node:url';
import { check } from '../../.claude/hooks/guard-shell.mjs';

export function checkInput(input) {
  const args = input?.tool_input ?? {};
  const commands = [args.command, args.cmd, args.chars, ...(Array.isArray(args.commands) ? args.commands : [])];
  const cwd = args.workdir ?? input.cwd ?? process.cwd();
  for (const command of commands) {
    if (typeof command !== 'string') continue;
    const reason = check(command, cwd);
    if (reason) return reason;
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const reason = checkInput(JSON.parse(raw || '{}'));
    if (reason) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `NOVO QA guard: ${reason}`,
      } }));
      process.stderr.write(`NOVO QA guard: ${reason}\n`);
      process.exitCode = 2;
    }
  } catch {
    process.stderr.write('NOVO QA guard: entrada inválida; comando bloqueado.\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
