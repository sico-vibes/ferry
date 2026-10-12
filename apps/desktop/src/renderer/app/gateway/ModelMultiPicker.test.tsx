import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ModelInfoSchema, ProviderSchema } from '@ferry/shared';
import { sampleProvider } from '@ferry/shared/testing';
import { ModelMultiPicker } from './ModelMultiPicker';

afterEach(cleanup);
it('offers standard API models and labels existing app-only choices without offering them for routing', () => {
  const app = ModelInfoSchema.parse({
    ref: 'opencode/app-only',
    providerId: 'opencode',
    name: 'App only',
    tier: 'T1',
    contextWindow: 128000,
    maxOutput: 4000,
    toolCalling: true,
    reasoning: false,
    free: true,
    priceInPerM: 0,
    priceOutPerM: 0,
  });
  const api = {
    ...app,
    ref: ModelInfoSchema.parse({ ...app, ref: 'opencode/api' }).ref,
    name: 'Standard API',
    apiAccessVerified: true,
  };
  const provider = ProviderSchema.parse({
    ...sampleProvider,
    id: 'opencode',
    name: 'Zen',
    enabled: true,
    keyStatus: 'valid',
  });
  render(
    <ModelMultiPicker
      value={[app.ref]}
      onChange={vi.fn()}
      models={[app, api]}
      providers={[provider]}
      emptyLabel="No models"
    />,
  );
  expect(screen.queryByRole('checkbox', { name: 'App only (Zen)' })).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Standard API (Zen)' })).toBeTruthy();
  expect(screen.getByText('Verify Zen API or CLI access')).toBeTruthy();
});
