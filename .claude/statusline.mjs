// Linha de status do Claude Code neste projeto. A entrada (stdin) traz o uso do plano
// (rate_limits: porcentagem usada e reset das janelas de 5 h e 7 dias) — o único lugar em que o
// Claude Code expõe esses números. Grava só eles em data/usage-limits.json para o painel ao vivo
// (npm run live) e mostra um resumo curto na linha de status.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'usage-limits.json');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(input); } catch { /* entrada vazia ou parcial */ }
  const limits = data.rate_limits ?? {};
  const pick = (w) => (w && typeof w.used_percentage === 'number' ? { used_percentage: w.used_percentage, resets_at: w.resets_at } : undefined);
  const five = pick(limits.five_hour);
  const week = pick(limits.seven_day);

  if (five || week) {
    try {
      mkdirSync(dirname(OUT), { recursive: true });
      const tmp = `${OUT}.tmp`;
      writeFileSync(tmp, JSON.stringify({ five_hour: five, seven_day: week, updatedAt: new Date().toISOString() }));
      renameSync(tmp, OUT);
    } catch { /* a linha de status nunca pode falhar por causa do painel */ }
  }

  const hhmm = (s) => new Date(s * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const day = (s) => new Date(s * 1000).toLocaleDateString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const free = (w) => `${Math.max(0, Math.round(100 - w.used_percentage))}% livre`;
  const parts = ['Sanctum'];
  if (five) parts.push(`5h: ${free(five)}${five.resets_at ? ` (renova ${hhmm(five.resets_at)})` : ''}`);
  if (week) parts.push(`semana: ${free(week)}${week.resets_at ? ` (renova ${day(week.resets_at)})` : ''}`);
  process.stdout.write(parts.join(' · '));
});
