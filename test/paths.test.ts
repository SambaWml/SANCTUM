import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { containedPath, UPLOAD_DIR } from '../src/security/paths.ts';

const root = mkdtempSync(join(tmpdir(), 'novo-qa-paths-'));
const base = join(root, UPLOAD_DIR);
mkdirSync(join(base, 'docs'), { recursive: true });
writeFileSync(join(base, 'docs', 'contrato.pdf'), 'pdf');
writeFileSync(join(root, '.env'), 'SECRET=1');
const outside = mkdtempSync(join(tmpdir(), 'novo-qa-outside-'));
writeFileSync(join(outside, 'secret.txt'), 'x');
// Junction (Windows) / symlink de diretório dentro da pasta de upload apontando para fora.
symlinkSync(outside, join(base, 'fuga'), 'junction');
afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

describe('containedPath (upload)', () => {
  it('aceita arquivo dentro da pasta de upload', () => {
    expect(containedPath(root, 'docs/contrato.pdf')).toBe(join(base, 'docs', 'contrato.pdf'));
    expect(containedPath(root, String.raw`docs\contrato.pdf`)).toBe(join(base, 'docs', 'contrato.pdf'));
  });

  it.each([
    ['../.env'],
    [String.raw`..\..\.env`],
    ['docs/../../.env'],
    [join(root, '.env')],
    [String.raw`C:\Windows\win.ini`],
    [String.raw`\\server\share\x.txt`],
    ['/etc/passwd'],
    ['fuga/secret.txt'],
    ['docs/nao-existe.pdf'],
    [''],
  ])('recusa %s', (p) => {
    expect(() => containedPath(root, p)).toThrow(/upload/);
  });
});
