import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Endereço do painel do Sanctum. O painel aprova os pedidos do agente; se o navegador do teste
 * abrisse o painel, o agente poderia aprovar a si mesmo. O painel grava a porta em uso e o
 * navegador do Sanctum recusa qualquer endereço local nessa porta.
 */
export const DEFAULT_LIVE_PORT = 4777;
const portFile = (rootDir: string) => join(rootDir, 'data', 'live-port.txt');

export function recordLivePort(rootDir: string, port: number): void {
  writeFileSync(portFile(rootDir), String(port));
}

export function isLivePanel(url: URL, rootDir: string): boolean {
  if (!['127.0.0.1', 'localhost', '0.0.0.0', '[::1]', '::1'].includes(url.hostname) && !url.hostname.endsWith('.localhost')) return false;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const ports = new Set([DEFAULT_LIVE_PORT]);
  try {
    if (existsSync(portFile(rootDir))) ports.add(Number(readFileSync(portFile(rootDir), 'utf8').trim()));
  } catch { /* sem porta gravada: vale a padrão */ }
  return ports.has(port);
}
