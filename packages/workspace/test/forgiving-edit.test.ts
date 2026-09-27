import { describe, expect, it } from 'vitest';
import { findForgivingEdit, editRepairHint } from '../src/forgiving-edit.js';
describe('forgiving edit matcher', () => {
  it.each([
    ['line-trimmed', '  alpha  \n beta  ', 'alpha\nbeta'],
    ['whitespace-normalized', 'alpha\n\t beta', 'alpha beta'],
    ['indentation-flexible', '    const value = 1;', 'const value = 1;'],
    ['escape-normalized', 'line\\nnext', 'line\nnext'],
    ['trimmed-boundary', 'alpha beta', 'alpha beta'],
  ])('matches %s edits', (_name, actual, search) => {
    expect(findForgivingEdit(actual, search)?.count).toBe(1);
  });
  it('reports exact repeated matches and refuses a disproportionate block', () => {
    const match = findForgivingEdit('x\nx\n', 'x');
    expect(match?.count).toBe(2);
    expect(match?.snippet.length).toBeLessThanOrEqual(80);
  });
  it('returns a model-facing hint with visible whitespace', () => {
    expect(editRepairHint('  const value = 2;', 'const value = 1;')).toContain(
      '··const·value·=·2;',
    );
  });
});
