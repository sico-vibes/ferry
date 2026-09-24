export const TERSE_LEVEL_TEXT: Readonly<Record<'Off' | 'Lite' | 'Full' | 'Ultra', string>> = {
  Off: 'Use normal concise prose.',
  Lite: 'Prefer concise wording. Preserve useful context and explain decisions clearly.',
  Full: 'Use short, direct sentences and compact lists. Remove repetition while preserving meaning and necessary reasoning.',
  Ultra:
    'Use the fewest words that fully answer the request. Keep actionable facts, outcomes, and needed context.',
};
export const TERSE_HARD_RULES =
  'Never compress code, commands, paths, exact errors, security warnings, approval prompts, or explanations the user asked for.';
export function terseSystemText(level: keyof typeof TERSE_LEVEL_TEXT): string {
  return level === 'Off'
    ? TERSE_LEVEL_TEXT.Off
    : `${TERSE_LEVEL_TEXT[level]} ${TERSE_HARD_RULES} Inspired by Caveman (MIT).`;
}
