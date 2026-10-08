import { describe, expect, it } from 'vitest';
import {
  editRepairHint,
  findForgivingEdit,
  findForgivingEditResult,
} from '../src/forgiving-edit.js';
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
  it('never throws on long search blocks that only match approximately', () => {
    const file = [
      '<script>',
      "  let posts = JSON.parse(localStorage.getItem('posts') || '[]');",
      '  if (posts.length === 0) {',
      "    posts = [{ id: 1, title: 'Welcome' }];",
      '    save();',
      '  }',
      "  const app = document.getElementById('app');",
      '</script>',
    ].join('\n');
    const search = [
      "        let posts = JSON.parse(localStorage.getItem('posts') || '[]');",
      "        const app = document.getElementById('app');",
      '        renderEverything();',
    ].join('\n');
    expect(() => findForgivingEditResult(file, search)).not.toThrow();
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
  it('names a copied truncation marker and offers a rewrite for small files', () => {
    const hint = editRepairHint(
      'const posts = [];\n',
      'const posts = [\n[output truncated; use recovery handle to retrieve the full output]',
    );
    expect(hint).toContain("Ferry's truncation marker");
    expect(hint).toContain('rewrite it completely with write_file');
    expect(editRepairHint('x'.repeat(40_000), 'y')).not.toContain('write_file');
  });
});
