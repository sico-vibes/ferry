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

  it('truncates long log strings by default but keeps synced records whole', () => {
    const long = 'x'.repeat(40_000);
    expect(redactForTelemetry(long)).toMatch(/\[TRUNCATED\]$/);
    expect(redactForTelemetry({ text: long }, { maxStringLength: Infinity })).toEqual({
      text: long,
    });
    expect(redactForTelemetry('key sk-or-abcdefghijk', { maxStringLength: Infinity })).toBe(
      'key [REDACTED]',
    );
  });
});
