// Adapted from OmniRoute Caveman (MIT), Copyright (c) 2026 diegosouzapw.
export type CavemanIntensity = 'lite' | 'standard' | 'aggressive';

interface Rule {
  pattern: RegExp;
  replacement: string;
  intensity: CavemanIntensity;
}

// Keep uncertainty, negation, quantities, and requested detail. These upstream
// rules shorten framing without changing whether a claim or requirement is true.
const rules: readonly Rule[] = [
  {
    pattern: /\b(?:could you please|would you please|can you please|please|kindly)\s+/gi,
    replacement: '',
    intensity: 'lite',
  },
  {
    pattern: /^(?:hi there|hello|good morning|hey)[,.!]?\s+/gim,
    replacement: '',
    intensity: 'lite',
  },
  {
    pattern:
      /\b(?:i would like you to|i want you to|i need you to|i was wondering if you could|would it be possible to)\s+/gi,
    replacement: '',
    intensity: 'lite',
  },
  {
    pattern: /^(?:i want to|i need to|i'd like to|i'm looking for)\s+/gim,
    replacement: '',
    intensity: 'lite',
  },
  {
    pattern: /\b(?:basically|essentially|actually|literally|simply|currently)\s+/gi,
    replacement: '',
    intensity: 'lite',
  },
  {
    pattern: /\b(?:due to the fact that|the reason is because)\s+/gi,
    replacement: 'because ',
    intensity: 'lite',
  },
  { pattern: /\b(?:in order to|so as to)\s+/gi, replacement: 'to ', intensity: 'lite' },
  { pattern: /\beach and every\b/gi, replacement: 'every', intensity: 'lite' },
  { pattern: /\bany and all\b/gi, replacement: 'all', intensity: 'lite' },
  { pattern: /\bfor the purpose of\s+/gi, replacement: 'for ', intensity: 'lite' },
  { pattern: /\b(?:make sure to|be sure to)\s+/gi, replacement: 'ensure ', intensity: 'standard' },
  {
    pattern: /\b(?:furthermore|additionally|moreover|in addition)[,]?\s+/gi,
    replacement: 'also ',
    intensity: 'standard',
  },
  { pattern: /\band also\s+/gi, replacement: 'and ', intensity: 'standard' },
  { pattern: /\bas well as\s+/gi, replacement: 'and ', intensity: 'standard' },
  { pattern: /\b(?:a|an|the)\s+(?=[a-z])/gi, replacement: '', intensity: 'standard' },
  { pattern: /\bdatabase\b/gi, replacement: 'DB', intensity: 'aggressive' },
  { pattern: /\bconfiguration\b/gi, replacement: 'config', intensity: 'aggressive' },
  { pattern: /\bauthentication\b/gi, replacement: 'auth', intensity: 'aggressive' },
];

const rank: Record<CavemanIntensity, number> = { lite: 0, standard: 1, aggressive: 2 };

export function compressProse(text: string, intensity: CavemanIntensity): string {
  let result = text;
  // Reach a fixed point so removing one phrase cannot expose another on a later
  // request. Every rule decreases length; this loop is bounded and fail-open.
  for (let pass = 0; pass < 32; pass += 1) {
    let candidate = result;
    for (const rule of rules) {
      if (rank[rule.intensity] <= rank[intensity])
        candidate = candidate.replace(rule.pattern, rule.replacement);
    }
    candidate = candidate.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.;:!?])/g, '$1');
    if (candidate === result) return result;
    result = candidate;
  }
  throw new Error('Caveman rules did not converge');
}
