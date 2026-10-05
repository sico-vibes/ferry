import type { ModelInfo } from '@ferry/shared';

/** Compact token count: 1048576 -> "1M", 131072 -> "131K". */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${String(Number(millions.toFixed(millions < 10 ? 1 : 0)))}M`;
  }
  if (value >= 1_000) return `${String(Math.round(value / 1_000))}K`;
  return String(value);
}

/**
 * Parameter count stated in the model id, e.g. "gpt-oss-120b" -> "120B" and
 * "qwen3-30b-a3b" -> "30B total, 3B active". Null when the id does not say.
 */
export function parameterCount(id: string): string | null {
  const match = /(?:^|[-_/:. ])(\d+(?:\.\d+)?)b(?:[-_]a(\d+(?:\.\d+)?)b)?(?=$|[-_/:. ])/i.exec(id);
  if (!match?.[1]) return null;
  return match[2] ? `${match[1]}B total, ${match[2]}B active` : `${match[1]}B`;
}

/** Release month for display, from "YYYY-MM-DD" or "YYYY-MM". */
export function formatMonth(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (!match?.[1] || !match[2]) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** 0..10 filled segments for a context window on a log scale from 8K to 2M. */
export function contextSegments(contextWindow: number): number {
  const min = Math.log2(8_192);
  const max = Math.log2(2_097_152);
  const position = (Math.log2(Math.max(contextWindow, 1)) - min) / (max - min);
  return Math.max(1, Math.min(10, Math.round(position * 10)));
}

export function priceLabel(
  model: Pick<ModelInfo, 'free' | 'priceInPerM' | 'priceOutPerM'>,
): string {
  if (model.free) return 'Free';
  if (model.priceInPerM === null || model.priceOutPerM === null) return 'Paid, price unknown';
  const money = (value: number) => `$${value < 1 ? value.toFixed(2) : String(value)}`;
  return `${money(model.priceInPerM)} in, ${money(model.priceOutPerM)} out per 1M`;
}

export function modalitiesLabel(modalities: string[] | undefined): string | null {
  if (!modalities?.length) return null;
  return modalities.map((item) => (item === 'pdf' ? 'PDF' : item)).join(', ');
}
