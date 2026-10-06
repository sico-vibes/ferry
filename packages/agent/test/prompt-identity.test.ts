import { describe, expect, it } from 'vitest';
import { withModelIdentity } from '../src/prompt.js';

describe('model identity in the system prompt', () => {
  it('names the model actually serving the step', () => {
    const system = withModelIdentity('Base rules', {
      ref: 'groq/openai/gpt-oss-120b',
      name: 'GPT OSS 120B',
      providerId: 'groq',
    });
    expect(system.startsWith('Base rules')).toBe(true);
    expect(system).toContain('served by GPT OSS 120B (groq/openai/gpt-oss-120b)');
    expect(system).toContain('project instruction files may name other assistants');
  });
});
