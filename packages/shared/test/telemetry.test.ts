import { describe, expect, it } from 'vitest';
import { newSpanId, newTraceId, redactForTelemetry } from '../src/index.js';

describe('telemetry primitives', () => {
  it('creates OTel-shaped ids', () => {
    expect(newTraceId()).toMatch(/^[a-f0-9]{32}$/);
    expect(newSpanId()).toMatch(/^[a-f0-9]{16}$/);
  });

  it('redacts nested credential fields and known secret shapes without redacting usage counts', () => {
    const safe = redactForTelemetry({
      inputTokens: 17,
      output_tokens: 4,
      maxTokens: 512,
      authorization: 'Bearer abc.def',
      nested: { apiKey: 'sk-or-abcdefghijk', token: 'sb_secret_abcdefghijk' },
      message: 'ghp_abcdefghijklmnopqrstuvwxyz012345 AKIA1234567890ABCDEF eyJabc.eyJdef.ghi',
    });
    expect(safe).toMatchObject({ inputTokens: 17, output_tokens: 4, maxTokens: 512 });
    expect(JSON.stringify(safe)).not.toMatch(/abc\.def|sk-or-|sb_secret_|ghp_|AKIA|eyJ/);
  });
});
