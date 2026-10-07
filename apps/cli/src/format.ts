import { marked } from 'marked';
import { highlight } from 'cli-highlight';
import type { CapacitySummary, ProviderLimits } from '@ferry/shared';
import { blue, emphasis, muted, warn } from './colors.js';
export { bad, blue, emphasis, good, gradient, muted, warn } from './colors.js';

/* marked exposes loosely typed nested tokens; the renderer narrows token kinds before use. */
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-condition */

export function formatCapacity(capacity: CapacitySummary): string {
  const filled = Math.round((capacity.percentRemaining / 100) * 9);
  const bar = '▰'.repeat(filled) + '▱'.repeat(9 - filled);
  return `${capacity.percentRemaining >= 80 ? warn(bar) : blue(bar)} ${capacity.percentRemaining}%`;
}

export function statusLine(
  profile: string,
  model: string,
  limits: readonly ProviderLimits[],
): string {
  const providerId = model.includes('/') ? model.slice(0, model.indexOf('/')) : undefined;
  const provider = limits.find((item) => item.providerId === providerId);
  const daily =
    provider?.windows.filter(
      (window) =>
        window.metric === 'requests' &&
        window.period === 'day' &&
        (!window.model || window.model === model) &&
        window.remaining !== null,
    ) ?? [];
  const remaining = daily.length ? Math.min(...daily.map((window) => window.remaining ?? 0)) : null;
  return `${blue(profile)} · ${model}${remaining === null ? '' : ` · ${remaining} daily requests left`}`;
}

export function formatLimits(limits: readonly ProviderLimits[]): string {
  return limits
    .map((provider) => {
      if (provider.state !== 'known')
        return `${provider.providerName}: ${provider.state === 'paid_no_limit' ? 'paid · no published daily/monthly limit' : 'no published daily/monthly limit'}`;
      return `${provider.providerName}\n${provider.windows
        .map(
          (window) =>
            `  ${window.model ? `${window.model} · ` : ''}${window.remaining ?? 'unknown'} / ${window.limit ?? 'unknown'} ${window.metric} left per ${window.period} · ${window.source}${window.resetAt ? ` · resets ${new Date(window.resetAt).toLocaleString()}` : ''}`,
        )
        .join('\n')}`;
    })
    .join('\n');
}

export function renderMarkdown(source: string): string {
  try {
    return renderMarkdownUnsafe(source);
  } catch {
    // Streaming fences and unsupported languages must never take down the TUI.
    return source;
  }
}

function renderMarkdownUnsafe(source: string): string {
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
          .replace(/\*\*(.+?)\*\*/g, (_match: string, text: string) => emphasis(text))
          .replace(/`(.+?)`/g, blue('$1'));
      if (token.type === 'blockquote') return muted(token.text);
      return token.raw?.trim() ?? '';
    })
    .filter(Boolean)
    .join('\n');
}
/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/* eslint-enable @typescript-eslint/restrict-template-expressions, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-condition */
