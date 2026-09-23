import { describe, expect, it } from 'vitest';
import { WorkspaceIdSchema } from '../src/index.js';

describe('WorkspaceIdSchema', () => {
  it('accepts a non-empty workspace id', () => {
    expect(WorkspaceIdSchema.parse('workspace-1')).toBe('workspace-1');
  });

  it('rejects an empty workspace id', () => {
    expect(() => WorkspaceIdSchema.parse('')).toThrow();
  });
});
