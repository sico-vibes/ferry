// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockFerryClient } from '@ferry/client';
import { ModelInfoSchema } from '@ferry/shared';
import { CliOptionsChip } from './CliOptionsChip';

afterEach(cleanup);

async function modelWithOptions(efforts: string[], fast = false) {
  const base = (await createMockFerryClient({ behavior: 'test' }).models.list())[0];
  if (!base) throw new Error('Missing model fixture');
  return ModelInfoSchema.parse({
    ...base,
    ref: 'codex-cli/gpt-test',
    providerId: 'codex-cli',
    name: 'Codex test model',
    free: false,
    cliConnectionId: 'codex-cli',
    cliCapabilities: {
      ref: 'codex-cli/gpt-test',
      connectionId: 'codex-cli',
      providerId: 'codex-cli',
      upstreamId: 'gpt-test',
      upstreamProvider: null,
      name: 'Codex test model',
      efforts,
      defaultEffort: efforts[0] ?? null,
      speeds: fast ? ['standard', 'fast'] : ['standard'],
      defaultSpeed: 'standard',
      modalities: ['text'],
      toolCalling: true,
      billing: 'included_subscription',
    },
  });
}

it('shows installed-client effort values and preserves the reported default, including ultra', async () => {
  const model = await modelWithOptions(['high', 'ultra']);
  const change = vi.fn();
  render(
    <CliOptionsChip
      model={model}
      value={{ effort: null, speed: 'standard' }}
      open
      onOpenChange={vi.fn()}
      onChange={change}
      busy={false}
      error=""
    />,
  );
  const effort = screen.getByRole('combobox', { name: 'CLI reasoning effort' });
  expect((effort as HTMLSelectElement).value).toBe('');
  expect(screen.getByRole('option', { name: 'Client default · High' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Low' })).toBeNull();
  fireEvent.change(effort, { target: { value: 'ultra' } });
  expect(change).toHaveBeenCalledWith({ effort: 'ultra', speed: 'standard' });
  expect(screen.queryByRole('switch', { name: 'CLI fast mode' })).toBeNull();
});

it('hides unsupported effort controls and keeps an advertised fast mode off until selected', async () => {
  const model = await modelWithOptions([], true);
  const change = vi.fn();
  render(
    <CliOptionsChip
      model={model}
      value={{ effort: null, speed: 'standard' }}
      open
      onOpenChange={vi.fn()}
      onChange={change}
      busy={false}
      error=""
    />,
  );
  expect(screen.queryByRole('combobox', { name: 'CLI reasoning effort' })).toBeNull();
  const fast = screen.getByRole('switch', { name: 'CLI fast mode' });
  expect(fast.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(fast);
  expect(change).toHaveBeenCalledWith({ effort: null, speed: 'fast' });
});

it('displays a stale effort override without substituting another value', async () => {
  const model = await modelWithOptions(['high']);
  const change = vi.fn();
  render(
    <CliOptionsChip
      model={model}
      value={{ effort: 'ultra', speed: 'standard' }}
      open
      onOpenChange={vi.fn()}
      onChange={change}
      busy={false}
      error="That effort is unavailable in the installed version."
    />,
  );
  expect(
    screen.getByRole<HTMLSelectElement>('combobox', { name: 'CLI reasoning effort' }).value,
  ).toBe('ultra');
  expect(
    screen.getByRole<HTMLOptionElement>('option', { name: 'Unavailable · Ultra' }).disabled,
  ).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('That effort is unavailable');
  expect(change).not.toHaveBeenCalled();
});

it('lets the user clear a saved Fast setting after the model stops advertising it', async () => {
  const model = await modelWithOptions(['high']);
  const change = vi.fn();
  render(
    <CliOptionsChip
      model={model}
      value={{ effort: 'high', speed: 'fast' }}
      open
      onOpenChange={vi.fn()}
      onChange={change}
      busy={false}
      error=""
    />,
  );
  expect(screen.queryByRole('switch', { name: 'CLI fast mode' })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('saved Fast setting is unavailable');
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use standard speed' }));
  expect(change).toHaveBeenCalledWith({ effort: 'high', speed: 'standard' });
});

it('explains advertised efforts the bridge cannot run and does not submit them', async () => {
  const model = await modelWithOptions(['high', 'ultra']);
  if (!model.cliCapabilities) throw new Error('Missing CLI capabilities');
  model.cliCapabilities.unsupportedEfforts = { ultra: 'This bridge cannot isolate that effort.' };
  const change = vi.fn();
  render(
    <CliOptionsChip
      model={model}
      value={{ effort: 'high', speed: 'standard' }}
      open
      onOpenChange={vi.fn()}
      onChange={change}
      busy={false}
      error=""
    />,
  );
  expect(
    screen.getByRole<HTMLOptionElement>('option', { name: 'Unavailable · Ultra' }).disabled,
  ).toBe(true);
  expect(screen.getByText('Ultra: This bridge cannot isolate that effort.')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'CLI reasoning effort' }), {
    target: { value: 'ultra' },
  });
  expect(change).not.toHaveBeenCalled();
});
