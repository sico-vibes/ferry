// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useUI } from '../state/ui';
import { CommandPalette, ModelPickerPopover } from './SessionPowerControls';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

describe('ModelPickerPopover', () => {
  it('selects Auto for the current session through the model API', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('Expected a fixture session');
    const select = vi.spyOn(client.models, 'select');
    render(
      <FerryProvider client={client}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ModelPickerPopover sessionId={session.id} modelName="GLM-5.3" mode="auto" />
        </QueryClientProvider>
      </FerryProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByText('Auto (recommended)'));
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith(session.id, 'auto');
    });
  });

  it('runs a command palette action from the keyboard', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    render(
      <FerryProvider client={client}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <CommandPalette />
        </QueryClientProvider>
      </FerryProvider>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.click(await screen.findByText('Toggle density (comfortable)'));
    expect(useUI.getState().density).toBe('compact');
    cleanup();
    useUI.getState().setDensity('comfortable');
  });
});
