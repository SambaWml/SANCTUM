import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTwgOutput } from '../src/sources/jira.ts';

describe('saída da twg', () => {
  const body = { data: [{ key: 'GURUJA-9039', summary: 'Tela de Desempenho' }] };

  it('JSON direto (processo sem variáveis de agente, ex.: MCP aberto pelo Antigravity)', () => {
    expect(parseTwgOutput(JSON.stringify(body, null, 2))).toEqual(body);
  });

  it('envelope de agente apontando o arquivo da resposta', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'twg-')), 'stdout.json');
    writeFileSync(file, JSON.stringify(body));
    const envelope = `output_files:\n  stdout: "${file.replace(/\\/g, '\\\\')}"\n  stdout_lines: 10\ncommand: "jira.workitem.get"\n`;
    expect(parseTwgOutput(envelope)).toEqual(body);
  });

  it('sem JSON: erro claro', () => {
    expect(() => parseTwgOutput('login necessário')).toThrow(/sem JSON/);
  });
});
