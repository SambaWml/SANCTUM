import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';

/** Única pasta de onde o upload lê arquivos (relativa à raiz do projeto). */
export const UPLOAD_DIR = join('fixtures', 'uploads');

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/**
 * Resolve um arquivo de upload dentro de fixtures/uploads e garante que o caminho real (depois de
 * seguir symlinks/junctions) continua lá dentro. Recusa caminho absoluto, UNC, `..` e arquivo
 * inexistente — assim nada fora da pasta (ex.: .env, .auth/) vai para a aplicação testada.
 */
export function containedPath(rootDir: string, file: string): string {
  const reject = (why: string): never => {
    throw new PathError(`upload recusado (${why}): use um arquivo dentro de ${UPLOAD_DIR}, com caminho relativo a ela`);
  };
  if (!file.trim()) reject('caminho vazio');
  if (isAbsolute(file) || win32.isAbsolute(file) || /^[a-z]:/i.test(file)) reject('caminho absoluto');
  const base = resolve(rootDir, UPLOAD_DIR);
  if (!existsSync(base)) reject(`a pasta ${UPLOAD_DIR} não existe`);
  const candidate = resolve(base, file.replace(/\\/g, '/'));
  const inside = (p: string, b: string) => {
    const rel = relative(b, p);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (!inside(candidate, base)) reject('fora da pasta de upload');
  if (!existsSync(candidate)) reject('arquivo não existe');
  const real = realpathSync(candidate);
  if (!inside(real, realpathSync(base))) reject('o caminho real sai da pasta de upload');
  if (!statSync(real).isFile()) reject('não é um arquivo');
  return candidate;
}
