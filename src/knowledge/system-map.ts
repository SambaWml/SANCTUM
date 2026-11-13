import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { ExecutionEntry } from './execution.ts';
import { projectDir } from './modules.ts';

/**
 * Mapa do sistema (modo descoberta, 12/11): o que existe no sistema testado — telas, o que cada uma
 * mostra, ações (com o risco), APIs e o acesso de cada papel. É a memória que faz o próximo teste
 * começar sabendo onde as coisas ficam. Só descreve o que foi VISTO: não é regra de negócio.
 * knowledge/<projeto>/mapa.yaml; cada tela guarda quando foi vista pela última vez (mapa envelhece).
 */

const text = (max: number) => z.string().min(2).max(max);
export const MapScreen = z.strictObject({
  route: z.string().min(1).max(200).describe('rota sem domínio; parâmetros como :id (ex.: /pacientes/:id)'),
  name: text(80),
  shows: z.array(text(160)).max(12).default([]).describe('o que a tela mostra (listas, contadores, filtros)'),
  actions: z.array(z.strictObject({ name: text(80), risk: z.enum(['GREEN', 'YELLOW', 'RED']).optional() })).max(20).default([]),
  apis: z.array(text(160)).max(15).default([]).describe('ex.: GET /api/appointments?date='),
  roles: z.record(z.string(), z.enum(['ok', 'blocked', 'unknown'])).default({}).describe('acesso de cada papel: só marque o que você viu'),
  lastSeen: z.string().optional(),
  source: z.enum(['visited', 'derived']).optional().describe('visited = aberta nesta missão; derived = deduzida de execuções antigas'),
});
export type MapScreen = z.infer<typeof MapScreen>;

export const SystemMap = z.strictObject({
  project: z.string(),
  updatedAt: z.string(),
  screens: z.array(MapScreen),
  entities: z.array(text(60)).default([]),
  /** Menus, links e rotas vistos e ainda não abertos: o mapa diz o que falta, não finge estar completo. */
  unvisited: z.array(text(160)).default([]),
});
export type SystemMap = z.infer<typeof SystemMap>;

export const SystemMapInput = z.strictObject({
  screens: z.array(MapScreen).min(1),
  entities: z.array(text(60)).optional(),
  unvisited: z.array(text(160)).optional(),
});
export type SystemMapInput = z.infer<typeof SystemMapInput>;

/** Dias sem ver uma tela para ela ser tratada como "pode ter mudado". */
export const MAP_STALE_DAYS = 30;

const mapPath = (rootDir: string, project: string) => join(projectDir(rootDir, project), 'mapa.yaml');
/** /pacientes/1043 e /pacientes/1044 são a mesma tela. */
export const routeKey = (route: string) => route.split('?')[0]!.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/+$/, '') || '/';

export function loadSystemMap(rootDir: string, project: string): SystemMap | null {
  const path = mapPath(rootDir, project);
  if (!existsSync(path)) return null;
  const parsed = SystemMap.safeParse(parse(readFileSync(path, 'utf8')));
  return parsed.success ? parsed.data : null;
}

const union = <T>(a: T[], b: T[], key: (x: T) => string, max: number) => {
  const out = new Map(a.map((x) => [key(x), x] as const));
  for (const x of b) out.set(key(x), x);
  return [...out.values()].slice(0, max);
};

/** Acrescenta ao mapa: tela nova entra, tela conhecida ganha o que foi visto agora. Nunca apaga. */
export function saveSystemMap(rootDir: string, project: string, raw: unknown, now = new Date()): { map: SystemMap; added: string[]; updated: string[]; file: string } {
  const input = SystemMapInput.parse(raw);
  const today = now.toISOString().slice(0, 10);
  const current = loadSystemMap(rootDir, project);
  const screens = new Map((current?.screens ?? []).map((s) => [routeKey(s.route), s] as const));
  const added: string[] = [];
  const updated: string[] = [];
  for (const s of input.screens) {
    const key = routeKey(s.route);
    const old = screens.get(key);
    const source = s.source ?? 'visited';
    if (!old) {
      screens.set(key, { ...s, route: key, lastSeen: today, source });
      added.push(key);
      continue;
    }
    screens.set(key, {
      route: key, name: s.name,
      shows: union(old.shows, s.shows, (x) => x.toLowerCase(), 12),
      actions: union(old.actions, s.actions, (x) => x.name.toLowerCase(), 20),
      apis: union(old.apis, s.apis, (x) => x.toLowerCase(), 15),
      // O que foi visto agora vale; 'unknown' nunca apaga um acesso já conhecido.
      roles: { ...old.roles, ...Object.fromEntries(Object.entries(s.roles).filter(([r, v]) => v !== 'unknown' || !old.roles[r])) },
      // Tela só deduzida não renova a data de uma tela já visitada.
      lastSeen: source === 'derived' && old.source === 'visited' ? old.lastSeen : today,
      source: old.source === 'visited' ? 'visited' : source,
    });
    updated.push(key);
  }
  const known = new Set(screens.keys());
  const map: SystemMap = {
    project, updatedAt: now.toISOString(),
    screens: [...screens.values()].sort((a, b) => a.route.localeCompare(b.route)),
    entities: union(current?.entities ?? [], input.entities ?? [], (x) => x.toLowerCase(), 60),
    // Sai da lista de "falta visitar" o que agora está no mapa.
    unvisited: union(current?.unvisited ?? [], input.unvisited ?? [], (x) => x.toLowerCase(), 80).filter((u) => !known.has(routeKey(u))),
  };
  mkdirSync(projectDir(rootDir, project), { recursive: true });
  writeFileSync(mapPath(rootDir, project), stringify(map, { lineWidth: 0 }));
  return { map, added, updated, file: `knowledge/${project}/mapa.yaml` };
}

/**
 * Primeira versão do mapa para um projeto que já foi testado: sai das rotas e ações validadas
 * (execution knowledge), marcada como "derived" — existe e funcionou, mas ninguém descreveu a tela.
 */
export function deriveMapFromExecution(rootDir: string, project: string): SystemMapInput | null {
  const dir = join(projectDir(rootDir, project), 'execution');
  if (!existsSync(dir)) return null;
  const byRoute = new Map<string, { actions: Map<string, string>; seen: string }>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let entries: ExecutionEntry[] = [];
    try { entries = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ExecutionEntry[]; } catch { continue; }
    for (const e of entries) {
      if (!e.route || e.action === 'navigate' || e.action === 'viewport') continue;
      const key = routeKey(e.route);
      const slot = byRoute.get(key) ?? { actions: new Map(), seen: '' };
      const t = e.target as { name?: string; label?: string; text?: string; placeholder?: string };
      const name = (t.name ?? t.label ?? t.text ?? t.placeholder ?? '').replace(/\d+/g, '#').trim();
      // Só o que alguém aciona de fato (botão, link, aba): campo preenchido não descreve a tela.
      if (name && name.length <= 60 && ['click', 'check', 'select'].includes(e.action)) slot.actions.set(name.toLowerCase(), name);
      if (e.lastSeen > slot.seen) slot.seen = e.lastSeen;
      byRoute.set(key, slot);
    }
  }
  if (!byRoute.size) return null;
  return {
    screens: [...byRoute.entries()].map(([route, s]) => ({
      route, name: route === '/' ? 'Entrada' : route.split('/').filter((p) => p && p !== ':id').pop() ?? route,
      shows: [], apis: [], roles: {}, source: 'derived' as const,
      actions: [...s.actions.values()].slice(0, 20).map((name) => ({ name })),
    })),
  };
}

/** Índice compacto do mapa para o agente: o detalhe de uma tela ele lê no arquivo quando precisar. */
export function mapIndex(map: SystemMap, now = new Date()) {
  const staleBefore = new Date(now.getTime() - MAP_STALE_DAYS * 86400_000).toISOString().slice(0, 10);
  const risky = map.screens.flatMap((s) => s.actions.filter((a) => a.risk === 'RED').map((a) => `${s.route}: ${a.name}`));
  const blocked = map.screens.flatMap((s) => Object.entries(s.roles).filter(([, v]) => v === 'blocked').map(([r]) => `${s.route} (${r})`));
  return {
    file: `knowledge/${map.project}/mapa.yaml`,
    updatedAt: map.updatedAt.slice(0, 10),
    screens: map.screens.map((s) => `${s.route} — ${s.name}${s.source === 'derived' ? ' [deduzida]' : ''}${(s.lastSeen ?? '') < staleBefore ? ' [vista há mais de 30 dias]' : ''}`),
    ...(map.entities.length ? { entities: map.entities } : {}),
    ...(risky.length ? { riskyActions: risky.slice(0, 15) } : {}),
    ...(blocked.length ? { blockedFor: blocked.slice(0, 15) } : {}),
    ...(map.unvisited.length ? { unvisited: map.unvisited.slice(0, 20) } : {}),
  };
}
