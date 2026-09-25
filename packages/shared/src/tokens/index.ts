import { countTokens } from 'gpt-tokenizer';

export interface TokenMessage {
  role: string;
  content: string;
}
export type TokenInput = string | readonly TokenMessage[];
export type TokenCorrectionFactors = Readonly<Record<string, number>>;

// The tokenizer can become quadratic on pathological repeated-character input.
// Keep exact tokenization for ordinary prompts and use a calibrated byte/character
// estimate for large payloads so tool output measurement stays bounded.
const EXACT_TOKEN_LIMIT = 16_384;

function familyKey(modelFamily?: string): string {
  return modelFamily?.trim().toLowerCase() ?? 'default';
}
export function estimateTokens(
  input: TokenInput,
  modelFamily?: string,
  correctionFactors: TokenCorrectionFactors = {},
): number {
  const messages =
    typeof input === 'string'
      ? input
      : input.map(({ role, content }) => `${role}: ${content}`).join('\n');
  const factor = correctionFactors[familyKey(modelFamily)] ?? correctionFactors.default ?? 1;
  const estimate =
    messages.length > EXACT_TOKEN_LIMIT ? Math.ceil(messages.length / 4) : countTokens(messages);
  return Math.max(0, Math.ceil(estimate * factor));
}

export function updateTokenCorrectionFactor(
  previous: number | undefined,
  estimated: number,
  reported: number,
  alpha = 0.2,
): number {
  if (!Number.isFinite(estimated) || estimated <= 0 || !Number.isFinite(reported) || reported < 0)
    return previous ?? 1;
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1)
    throw new RangeError('alpha must be in (0, 1]');
  const observed = reported / estimated;
  return previous === undefined ? observed : previous + alpha * (observed - previous);
}
