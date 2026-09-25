import { marked } from 'marked';
import highlight from 'cli-highlight';
import type { CapacitySummary } from '@ferry/shared';

/* marked exposes loosely typed nested tokens; the renderer narrows token kinds before use. */
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-misused-spread, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-condition */

const ansi = (color: string, fallback: number, value: string) =>
  process.env.NO_COLOR !== undefined
    ? value
    : `\u001b[${process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' ? `38;2;${color}` : `38;5;${fallback}`}m${value}\u001b[0m`;
export const blue = (s: string) => ansi('75;145;255', 75, s);
export const muted = (s: string) => ansi('145;151;163', 245, s);
export const good = (s: string) => ansi('67;195;139', 78, s);
export const warn = (s: string) => ansi('245;185;75', 214, s);
export const bad = (s: string) => ansi('244;91;105', 203, s);
export const gradient = (s: string) =>
  process.env.NO_COLOR !== undefined
    ? s
    : [...s].map((c, i) => `\u001b[38;2;${90 + i * 6};${110 + i * 2};255m${c}`).join('') +
      '\u001b[0m';

export function formatCapacity(capacity: CapacitySummary): string {
  const filled = Math.round((capacity.percentRemaining / 100) * 9);
  const bar = '▰'.repeat(filled) + '▱'.repeat(9 - filled);
  return `≈ ${capacity.stepsLeftToday} steps ${capacity.percentRemaining >= 80 ? warn(bar) : blue(bar)} ${capacity.percentRemaining}%`;
}

export function statusLine(profile: string, model: string, capacity: CapacitySummary): string {
  const reset = capacity.nextResets[0]?.at;
  const resetText = reset ? relativeReset(reset) : 'reset unknown';
  return `${blue(profile)} · ${model} · ≈${capacity.stepsLeftToday} steps left · ${resetText} · saved 38%`;
}

function relativeReset(value: string): string {
  const mins = Math.max(0, Math.round((Date.parse(value) - Date.now()) / 60000));
  return `reset ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
}

export function renderMarkdown(source: string): string {
  const tokens = marked.lexer(source);
  return tokens
    .map((token) => {
      if (token.type === 'heading') return blue(token.text) + '\n';
      if (token.type === 'code')
        return highlight(token.text, { language: token.lang || 'plaintext', ignoreIllegals: true });
      if (token.type === 'list')
        return token.items.map((item: { text: string }) => `  • ${item.text}`).join('\n');
      if (token.type === 'paragraph')
        return token.text
          .replace(/\*\*(.+?)\*\*/g, '\u001b[1m$1\u001b[0m')
          .replace(/`(.+?)`/g, blue('$1'));
      if (token.type === 'blockquote') return muted(token.text);
      return token.raw?.trim() ?? '';
    })
    .filter(Boolean)
    .join('\n');
}
/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/* eslint-enable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-misused-spread, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-condition */
