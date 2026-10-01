// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { keys } from '../data/queries';
import { useUI } from '../state/ui';
import { CommandPalette, ModelPickerPopover } from './SessionPowerControls';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

describe('ModelPickerPopover', () => {
  it('switches Manual to Auto by mouse and back to Manual by keyboard', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const firstSession = (await client.sessions.list())[0];
    if (!firstSession) throw new Error('Expected a fixture session');
    const candidates = await client.models.candidates(firstSession.id);
    const autoCandidate = candidates[0];
    if (!autoCandidate) throw new Error('Expected an automatic model candidate');
    await client.models.select(firstSession.id, autoCandidate.ref);
    const session = (await client.sessions.get(firstSession.id)).session;
    const models = await client.models.list();
    const autoModel = models.find((model) => model.ref === autoCandidate.ref);
    if (!autoModel) throw new Error('Expected candidate metadata');

    function PickerHarness() {
      const { data } = useQuery({
        queryKey: keys.session(session.id),
        queryFn: () => client.sessions.get(session.id),
      });
      const currentSession = data?.session ?? session;
      const selectedRef = currentSession.pinnedModelRef ?? currentSession.modelRef;
      const selectedModel = models.find((model) => model.ref === selectedRef) ?? autoModel;
      if (!selectedModel) throw new Error('Expected selected model metadata');
      return (
        <ModelPickerPopover
          sessionId={session.id}
          modelName={selectedModel.name}
          mode={currentSession.pinnedModelRef ? 'manual' : 'auto'}
        />
      );
    }

    render(
      <FerryProvider client={client}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <PickerHarness />
        </QueryClientProvider>
      </FerryProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Manual ·/ }));
    fireEvent.click(await screen.findByText('Auto (recommended)'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: `Auto · ${autoModel.name}` })).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Auto ·/ }));
    const search = screen.getByRole('combobox', { name: 'Choose model' });
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(screen.getByRole('option', { selected: true }).classList.contains('auto')).toBe(false);
    });
    const selectedOption = screen.getByRole('option', { selected: true });
    const selectedNameElement = selectedOption.querySelector('strong');
    if (!selectedNameElement) throw new Error('Expected a selected model option');
    const selectedName = selectedNameElement.textContent.trim();
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => {
      const trigger = screen.getByRole('button', { name: /Manual ·/ });
      expect(trigger).toBeTruthy();
      expect(trigger.textContent).toContain(`Manual · ${selectedName}`);
      expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Manual ·/ }));
    const keyboardSearch = screen.getByRole('combobox', { name: 'Choose model' });
    keyboardSearch.focus();
    fireEvent.keyDown(keyboardSearch, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: `Auto · ${autoModel.name}` })).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Auto ·/ }));
    const mouseModel = screen
      .getAllByRole('option')
      .find((option) => !option.classList.contains('auto'));
    if (!mouseModel) throw new Error('Expected a manual model option');
    const mouseModelNameElement = mouseModel.querySelector('strong');
    if (!mouseModelNameElement) throw new Error('Expected a manual model name');
    const mouseModelName = mouseModelNameElement.textContent.trim();
    fireEvent.click(mouseModel);
    await waitFor(() => {
      const trigger = screen.getByRole('button', { name: /Manual ·/ });
      expect(trigger).toBeTruthy();
      expect(trigger.textContent).toContain(`Manual · ${mouseModelName}`);
      expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull();
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

  it('creates and opens a session from the New Chat command', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    useUI.setState({ tabs: [], activeId: null, pendingComposerFocus: false });
    render(
      <FerryProvider client={client}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <CommandPalette />
        </QueryClientProvider>
      </FerryProvider>,
    );
    const workspaces = await client.workspaces.list();
    const workspace = workspaces[0];
    if (!workspace) throw new Error('Expected a fixture workspace');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByRole('dialog', { name: 'Command palette' });
    await screen.findByText(workspace.name);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '> New Chat' } });
    fireEvent.click(await screen.findByRole('option', { name: /^New Chat$/ }));

    await waitFor(() => {
      const [tab] = useUI.getState().tabs;
      expect(tab?.title).toBe('New Chat');
      expect(useUI.getState().pendingComposerFocus).toBe(true);
    });
    const [tab] = useUI.getState().tabs;
    const sessions = await client.sessions.list();
    expect(
      sessions.some((session) => session.id === tab?.id && session.workspaceId === workspace.id),
    ).toBe(true);
    useUI.setState({ tabs: [], activeId: null, pendingComposerFocus: false });
  });

  it('searches sessions and limits `>` queries to commands', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const sessions = await client.sessions.list();
    const session = sessions[0];
    if (!session) throw new Error('Expected a fixture session');
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
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    const search = screen.getByRole('combobox');
    expect(dialog.querySelector('[role="listbox"]')).toBeTruthy();
    fireEvent.change(search, { target: { value: session.title } });
    const recentSessions = await screen.findByRole('group', { name: 'Recent sessions' });
    expect(await within(recentSessions).findByRole('option')).toBeTruthy();
    fireEvent.change(search, { target: { value: '> New Chat' } });
    await waitFor(() => {
      expect(screen.queryByText('Recent sessions')).toBeNull();
    });
    expect(await screen.findByRole('option', { name: /^New Chat$/ })).toBeTruthy();
  });
});
