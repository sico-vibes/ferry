import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { FerryClient } from '@ferry/client';
import type { OAuthLoginProgress } from '@ferry/shared';
import { FerryProvider } from '../data/client';
import { OAuthFlowDialog } from './OAuthFlowDialog';

afterEach(cleanup);
function setup() {
  let receive: (event: OAuthLoginProgress) => void = () => undefined;
  const respond = vi.fn().mockResolvedValue(undefined);
  const cancel = vi.fn().mockResolvedValue(undefined);
  const client = {
    on: (_name: string, handler: typeof receive) => {
      receive = handler;
      return () => undefined;
    },
    oauth: { respond, cancel },
  } as unknown as FerryClient;
  render(
    <FerryProvider client={client}>
      <OAuthFlowDialog />
    </FerryProvider>,
  );
  return {
    respond,
    cancel,
    emit: (event: OAuthLoginProgress) => {
      act(() => {
        receive(event);
      });
    },
  };
}
it('shows browser authorization as pending, submits a manual redirect, and closes on success', async () => {
  const h = setup();
  const user = userEvent.setup();
  h.emit({ type: 'open_url', id: 'anthropic', url: 'https://example.test/login' });
  expect(screen.getByRole('status').textContent).toContain('Waiting for authorization');
  h.emit({
    type: 'prompt',
    id: 'anthropic',
    promptId: 'prompt-1',
    kind: 'manual_code',
    message: 'Paste redirect',
  });
  await user.type(screen.getByRole('textbox'), 'fixture-code');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => {
    expect(h.respond).toHaveBeenCalledWith('anthropic', 'prompt-1', 'fixture-code');
  });
  h.emit({ type: 'success', id: 'anthropic' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('lets the user cancel browser sign-in', async () => {
  const h = setup();
  const user = userEvent.setup();
  h.emit({ type: 'progress', id: 'openai-codex', message: 'Preparing sign-in' });
  await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  expect(h.cancel).toHaveBeenCalledWith('openai-codex');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('shows device codes and hides secret prompts while retaining a retry after submission failure', async () => {
  const h = setup();
  const user = userEvent.setup();
  h.emit({
    type: 'device_code',
    id: 'github-copilot',
    verificationUri: 'https://example.test/device',
    userCode: 'ABCD-EFGH',
  });
  expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
  h.emit({
    type: 'prompt',
    id: 'github-copilot',
    promptId: 'secret',
    kind: 'secret',
    message: 'Access token',
  });
  const input = screen.getByLabelText('Access token');
  expect(input.getAttribute('type')).toBe('password');
  h.respond.mockRejectedValueOnce(new Error('Retry authorization'));
  await user.type(input, 'fixture-secret');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Retry authorization');
  expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  expect(h.cancel).toHaveBeenCalledWith('github-copilot');
});
