import { describe, expect, it } from 'vitest';
import {
  CliConnectionSettingsSchema,
  resolveCliOption,
  type CliModelCapabilities,
} from '../src/index.js';

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

  it('never defaults fast on and returns an explicit speed verbatim (no silent normalization)', () => {
    expect(
      resolveCliOption({ model: model(), connection: { effort: null, speed: 'standard' } }).speed,
    ).toBe('standard');
    expect(resolveCliOption({ model: model(), conversation: { speed: 'fast' } }).speed).toBe(
      'fast',
    );
    // An explicit fast the model does not advertise is returned verbatim so the caller rejects it
    // before generation instead of silently substituting standard.
    expect(
      resolveCliOption({
        model: model({ speeds: ['standard'] }),
        conversation: { speed: 'fast' },
      }).speed,
    ).toBe('fast');
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

describe('CliConnectionSettingsSchema.modelDefaults', () => {
  it('keeps omitted/undefined per-model fields absent so they inherit, and preserves explicit null', () => {
    const parsed = CliConnectionSettingsSchema.parse({
      defaultOptions: { effort: 'high' },
      modelDefaults: { 'codex-cli/m': { effort: undefined, speed: 'fast' } },
    });
    // defaultOptions materializes only its own defaults (effort 'high' kept; speed defaults).
    expect(parsed.defaultOptions).toEqual({ effort: 'high', speed: 'standard' });
    // The per-model override must NOT materialize effort:null — it stays undefined (inherits).
    const [perModel] = Object.values(parsed.modelDefaults);
    expect(perModel).toEqual({ speed: 'fast' });
    expect(perModel?.effort).toBeUndefined();
  });

  it('preserves an explicit effort:null per-model record as an intentional default', () => {
    const parsed = CliConnectionSettingsSchema.parse({
      modelDefaults: { 'codex-cli/m': { effort: null } },
    });
    const [perModel] = Object.values(parsed.modelDefaults);
    expect(perModel).toEqual({ effort: null });
  });

  it('composes with the shared resolver: absent inherits the connection High; explicit null stops at the CLI default', () => {
    const m = model({ defaultEffort: 'medium' });
    const absent = CliConnectionSettingsSchema.parse({
      defaultOptions: { effort: 'high' },
      modelDefaults: { 'codex-cli/m': { speed: 'fast' } },
    });
    expect(
      resolveCliOption({
        model: m,
        connection: absent.defaultOptions,
        connectionModel: Object.values(absent.modelDefaults)[0],
      }),
    ).toEqual({ effort: 'high', speed: 'fast' });
    const explicitNull = CliConnectionSettingsSchema.parse({
      defaultOptions: { effort: 'high' },
      modelDefaults: { 'codex-cli/m': { effort: null } },
    });
    expect(
      resolveCliOption({
        model: m,
        connection: explicitNull.defaultOptions,
        connectionModel: Object.values(explicitNull.modelDefaults)[0],
      }),
    ).toEqual({ effort: 'medium', speed: 'standard' });
  });
});
