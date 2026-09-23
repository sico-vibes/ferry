import { describe, expect, it } from 'vitest';
import { describeClient } from '../src/index.js';

describe('describeClient', () => {
  it('describes the configured protocol version', () => {
    expect(describeClient({ protocolVersion: 'ferry/1' })).toBe('Ferry client protocol ferry/1');
  });
});
