import { cavemanOutputInstruction } from './caveman/output.js';

export const TERSE_LEVEL_TEXT: Readonly<Record<'Off' | 'Lite' | 'Full' | 'Ultra', string>> = {
  Off: 'Use normal concise prose.',
  Lite: cavemanOutputInstruction('lite'),
  Full: cavemanOutputInstruction('full'),
  Ultra: cavemanOutputInstruction('ultra'),
};
export const TERSE_HARD_RULES =
  'Never compress code, commands, paths, exact errors, security warnings, approval prompts, or explanations the user asked for.';
export function terseSystemText(level: keyof typeof TERSE_LEVEL_TEXT): string {
  return level === 'Off' ? TERSE_LEVEL_TEXT.Off : `${TERSE_LEVEL_TEXT[level]} ${TERSE_HARD_RULES}`;
}
