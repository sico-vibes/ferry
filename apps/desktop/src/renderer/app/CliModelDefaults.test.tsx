// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockFerryClient } from '@ferry/client';
import { ModelInfoSchema } from '@ferry/shared';
import { CliModelDefaults } from './CliModelDefaults';

afterEach(cleanup);

it('keeps an unavailable saved speed visible so the profile can be repaired', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  const base = (await client.models.list())[0];
  const capabilities = (await client.cliConnections.list()).find(
    (item) => item.kind === 'codex-cli',
  )?.models[0];
  if (!base || !capabilities) throw new Error('Missing model fixtures');
  const model = ModelInfoSchema.parse({
    ...base,
    ref: capabilities.ref,
    providerId: capabilities.providerId,
    cliConnectionId: 'codex-cli',
    cliCapabilities: { ...capabilities, speeds: ['standard'] },
  });
  const change = vi.fn();
  render(
    <CliModelDefaults
      models={[model]}
      defaults={{ [model.ref]: { effort: 'high', speed: 'fast' } }}
      onChange={change}
    />,
  );
  const speed = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Default CLI speed' });
  expect(speed.value).toBe('fast');
  expect(
    screen.getByRole<HTMLOptionElement>('option', { name: 'Unavailable · Fast' }).disabled,
  ).toBe(true);
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(speed, { target: { value: 'standard' } });
  expect(change).toHaveBeenCalledWith({ [model.ref]: { effort: 'high', speed: 'standard' } });
});
