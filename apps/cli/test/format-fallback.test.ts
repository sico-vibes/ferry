import { expect, it, vi } from 'vitest';
import { renderMarkdown } from '../src/format.js';

vi.mock('cli-highlight', () => ({
  highlight: () => {
    throw new Error('renderer failed');
  },
}));

it('preserves the plain reply when markdown rendering fails', () => {
  const reply = 'Reply with code:\n\n```ts\nconst answer = 42;\n```';
  expect(renderMarkdown(reply)).toBe(reply);
});
