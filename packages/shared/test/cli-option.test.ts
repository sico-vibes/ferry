import { describe, expect, it } from 'vitest';
import { resolveCliOption, type CliModelCapabilities } from '../src/index.js';

function model(overrides: Partial<CliModelCapabilities> = {}): CliModelCapabilities {
  return {
    ref: 'codex-cli/m' as CliModelCapabilities['ref'],
    connectionId: 'codex-cli',
    providerId: 'codex-cli',
    upstreamId: 'm',
    upstreamProvider: null,
    name: 'M',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    speeds: ['standard', 'fast'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    billing: 'included_subscription',
    hidden: false,
    ...overrides,
  };
}

describe('resolveCliOption', () => {
  it('falls back to the reported CLI default effort and standard speed when no layer selects one', () => {
    expect(resolveCliOption({ model: model() })).toEqual({ effort: 'medium', speed: 'standard' });
  });

  it('an explicit null effort in a higher layer selects the reported default and stops fall-through', () => {
    // conversation null must NOT fall through to profile High (regression for the `??` bug).
    expect(
      resolveCliOption({
        model: model({ defaultEffort: 'low' }),
        conversation: { effort: null, speed: 'standard' },
        profile: { effort: 'high' },
        connection: { effort: null, speed: 'standard' },
      }),
    ).toEqual({ effort: 'low', speed: 'standard' });
  });

  it('a per-model explicit null stops before a connection default High', () => {
    expect(
      resolveCliOption({
        model: model({ defaultEffort: 'medium' }),
        connectionModel: { effort: null },
        connection: { effort: 'high', speed: 'standard' },
      }),
    ).toEqual({ effort: 'medium', speed: 'standard' });
  });

  it('highest defined field wins across conversation > profile > connection model > connection', () => {
    expect(
      resolveCliOption({
        model: model(),
        conversation: { effort: 'high' },
        profile: { effort: 'low' },
        connectionModel: { effort: 'medium' },
        connection: { effort: null, speed: 'standard' },
      }),
    ).toEqual({ effort: 'high', speed: 'standard' });
    expect(
      resolveCliOption({
        model: model(),
        profile: { effort: 'low' },
        connectionModel: { effort: 'high' },
        connection: { effort: null, speed: 'standard' },
      }),
    ).toEqual({ effort: 'low', speed: 'standard' });
  });

  it('an absent partial field inherits while a present field wins', () => {
    expect(
      resolveCliOption({
        // Only speed is set here; effort must inherit from the deeper profile layer.
        conversation: { speed: 'fast' },
        profile: { effort: 'low' },
        connection: { effort: null, speed: 'standard' },
        model: model(),
      }),
    ).toEqual({ effort: 'low', speed: 'fast' });
  });

  it('never defaults fast on and sanitizes an unsupported fast to standard', () => {
    expect(
      resolveCliOption({ model: model(), connection: { effort: null, speed: 'standard' } }).speed,
    ).toBe('standard');
    expect(resolveCliOption({ model: model(), conversation: { speed: 'fast' } }).speed).toBe(
      'fast',
    );
    expect(
      resolveCliOption({
        model: model({ speeds: ['standard'] }),
        conversation: { speed: 'fast' },
      }).speed,
    ).toBe('standard');
  });

  it('does not silently substitute a disabled/unsupported implicit default effort', () => {
    // The reported default is advertised but bridge-unrunnable: resolve to null, never another token.
    expect(
      resolveCliOption({
        model: model({
          efforts: ['low', 'ultra'],
          defaultEffort: 'ultra',
          unsupportedEfforts: { ultra: 'bridge unsupported' },
        }),
      }),
    ).toEqual({ effort: null, speed: 'standard' });
    // A reported default that is not advertised at all likewise resolves to null.
    expect(resolveCliOption({ model: model({ efforts: ['low'], defaultEffort: 'high' }) })).toEqual(
      {
        effort: null,
        speed: 'standard',
      },
    );
  });

  it('returns an explicit unavailable effort verbatim so dispatch can reject it, not silently swap it', () => {
    expect(
      resolveCliOption({
        model: model({ efforts: ['low'], defaultEffort: 'low' }),
        conversation: { effort: 'xhigh' },
      }).effort,
    ).toBe('xhigh');
  });
});
