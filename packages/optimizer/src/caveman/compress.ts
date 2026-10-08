// Adapted from OmniRoute Caveman and languageDetector.ts (MIT),
// Copyright (c) 2026 diegosouzapw.
import { estimateTokens } from '../measurement.js';
import { compressProse, type CavemanIntensity } from './rules.js';
import { preservedSpans } from './preserve.js';

export interface CavemanResult {
  text: string;
  beforeTokens: number;
  afterTokens: number;
  applied: boolean;
  skippedReason?: string;
}

// English-only adaptation of upstream native-keyword detection. Unknown or
// mixed language is deliberately left alone rather than forced through EN rules.
function isEnglish(text: string): boolean {
  return (
    !/[^\u0020-\u007e\t\n\r\u2010-\u2027]/.test(text) &&
    !/\b(?:perche|pero|quindi|potresti|vorrei|grazie|questo|voce|preciso|arquivo|codigo|obrigado|necesito|archivo|gracias|puedes|ich|datei|fehler|bitte|kannst|danke|fichier|erreur|merci|peux|besoin|saya|kamu|anda|dengan|untuk|yang|tidak|bisa)\b/i.test(
      text,
    ) &&
    /\b(?:i|you|we|it|is|are|was|be|have|has|can|could|would|should|please|the|this|that|to|and|for|with|because|not)\b/i.test(
      text,
    )
  );
}

export function cavemanCompress(
  text: string,
  options: { intensity: CavemanIntensity },
): CavemanResult {
  const beforeTokens = estimateTokens(text);
  const skip = (skippedReason: string): CavemanResult => ({
    text,
    beforeTokens,
    afterTokens: beforeTokens,
    applied: false,
    skippedReason,
  });
  try {
    if (!['lite', 'standard', 'aggressive'].includes(options.intensity))
      return skip('invalid-intensity');
    if (text.includes('\u0000')) return skip('malformed-input');
    const spans = preservedSpans(text);
    let cursor = 0;
    const prose =
      spans
        .map((span) => {
          const chunk = text.slice(cursor, span.start);
          cursor = span.end;
          return chunk;
        })
        .join(' ') +
      ' ' +
      text.slice(cursor);
    if (!isEnglish(prose)) return skip('non-english-or-unknown');
    cursor = 0;
    let candidate = '';
    const restored: { start: number; content: string }[] = [];
    for (const span of spans) {
      candidate += compressProse(text.slice(cursor, span.start), options.intensity);
      const content = text.slice(span.start, span.end);
      restored.push({ start: candidate.length, content });
      candidate += content;
      cursor = span.end;
    }
    candidate += compressProse(text.slice(cursor), options.intensity);
    if (
      restored.some(
        (span) => candidate.slice(span.start, span.start + span.content.length) !== span.content,
      )
    )
      return skip('preserved-block-mismatch');
    // Re-parse the candidate so changed prose cannot create a broken fence.
    preservedSpans(candidate);
    if (
      text.length < 500 &&
      (candidate.length < text.length * 0.4 || estimateTokens(candidate) < beforeTokens * 0.4)
    )
      return skip('excessive-short-text-shrink');
    const afterTokens = estimateTokens(candidate);
    if (afterTokens >= beforeTokens || candidate.length >= text.length) return skip('no-savings');
    return { text: candidate, beforeTokens, afterTokens, applied: true };
  } catch {
    return skip('validation-failed');
  }
}
