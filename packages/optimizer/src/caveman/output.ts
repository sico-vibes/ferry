// Adapted from OmniRoute outputMode.ts (MIT), Copyright (c) 2026 diegosouzapw.
// Output mode contract from JuliusBrussee/caveman (MIT).
export const SHARED_BOUNDARIES =
  'Code blocks, file paths, commands, errors, URLs: keep exact. Security warnings, irreversible action confirmations, multi-step ordered sequences: write normal. Resume terse style after. Active every response until user asks for normal mode.';

export const FERRY_BOUNDARIES =
  'Tool arguments, file contents, code, commands, and diffs: write normally and completely.';

const instructions = {
  lite: 'Respond concise. Drop filler, pleasantries, hedging. Keep full sentences, technical terms, code, errors, URLs, and identifiers exact.',
  full: 'Respond terse like smart caveman. Drop articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms (big not extensive, fix not implement). Keep all technical substance, code, errors, URLs, identifiers exact.',
  ultra:
    'Respond ultra terse. Maximum compression. Telegraphic. Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y). One word when one word enough. Never abbreviate code symbols, API names, error strings, URLs, or identifiers.',
} as const;

export function cavemanOutputInstruction(level: 'off' | keyof typeof instructions): string {
  return level === 'off' ? '' : `${instructions[level]} ${SHARED_BOUNDARIES} ${FERRY_BOUNDARIES}`;
}
