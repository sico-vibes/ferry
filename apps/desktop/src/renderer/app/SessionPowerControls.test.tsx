// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import type { FerryEvents } from '@ferry/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useFerryEvents } from '../data/events';
import { keys } from '../data/queries';
import { useUI } from '../state/ui';
import { CommandPalette, ComposerModelChip } from './SessionPowerControls';
import { Composer } from '@ferry/ui';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

describe('ComposerModelChip', () => {
  it('opens above the composer chip with a viewport-clamped picker', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const session = (await client.sessions.list())[0];
    const model = (await client.models.list())[0];
    if (!session || !model) throw new Error('Expected fixture session and model');

    render(
      <FerryProvider client={client}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ComposerModelChip sessionId={session.id} modelName={model.name} mode="manual" />
        </QueryClientProvider>
      </FerryProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: model.name }));
    const picker = await screen.findByRole('dialog', { name: 'Choose model' });
    expect(picker.getAttribute('data-side')).toBe('top');
    expect(picker.getAttribute('data-align')).toBe('start');
    expect(picker.style.maxHeight).toBe(
      'min(560px, var(--radix-popover-content-available-height))',
    );
  });

  it('switches profiles from the picker and updates the profile chip', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const session = (await client.sessions.list())[0];
    const profiles = await client.profiles.list();
    const sessionDetail = session ? await client.sessions.get(session.id) : null;
    const currentProfile = profiles.find(
      (profile) => profile.id === sessionDetail?.session.profileId,
    );
    const nextProfile = profiles.find((profile) => profile.id !== currentProfile?.id);
    if (!session || !sessionDetail || !currentProfile || !nextProfile) {
      throw new Error('Expected a fixture session with at least two profiles');
    }
    const fixtureSession = session;
    const initialSessionDetail = sessionDetail;
    const initialProfile = currentProfile;
    const targetProfile = nextProfile;
    const activateProfile = vi.spyOn(client.profiles, 'activate');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(keys.session(fixtureSession.id), initialSessionDetail);

    function ProfilePickerHarness() {
      const { data } = useQuery({
        queryKey: keys.session(fixtureSession.id),
        queryFn: () => client.sessions.get(fixtureSession.id),
      });
      const activeProfileId = data?.session.profileId ?? initialProfile.id;
      const activeProfile = profiles.find((profile) => profile.id === activeProfileId);

      return (
        <ComposerModelChip
          sessionId={fixtureSession.id}
          modelName="GLM-5.3"
          mode="auto"
          profiles={profiles}
          activeProfileId={activeProfileId}
          profileName={activeProfile?.name ?? 'Profile'}
          onProfileSelect={(profileId) => {
            void (async () => {
              await client.profiles.activate(profileId, fixtureSession.id);
              await queryClient.invalidateQueries({ queryKey: keys.session(fixtureSession.id) });
            })();
          }}
        />
      );
    }

    render(
      <FerryProvider client={client}>
        <QueryClientProvider client={queryClient}>
          <ProfilePickerHarness />
        </QueryClientProvider>
      </FerryProvider>,
    );

    const initialChip = screen.getByRole('button', { name: /^Auto ·/ });
    expect(initialChip.textContent).toContain(initialProfile.name);
    fireEvent.click(initialChip);
    const picker = await screen.findByRole('dialog', { name: 'Choose model' });
    const listbox = within(picker).getByRole('listbox', { name: 'Suggestions' });
    const group = within(listbox)
      .getByText('Profile', { selector: '[cmdk-group-heading]' })
      .closest('[cmdk-group]');
    if (!(group instanceof HTMLElement)) throw new Error('Expected the profile options group');
    expect(within(group).getAllByRole('option')).toHaveLength(profiles.length);
    const activeOption = within(group).getByRole('option', {
      name: new RegExp(initialProfile.name),
    });
    expect(activeOption.getAttribute('aria-selected')).toBe('true');
    expect(activeOption.querySelector('svg')).toBeTruthy();

    const option = within(group).getByRole('option', { name: new RegExp(targetProfile.name) });
    fireEvent.click(option);
    await waitFor(() => {
      expect(activateProfile).toHaveBeenCalledWith(targetProfile.id, fixtureSession.id);
      expect(screen.getByRole('button', { name: /^Auto ·/ }).textContent).toContain(
        targetProfile.name,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: /^Auto ·/ }));
    const updatedPicker = await screen.findByRole('dialog', { name: 'Choose model' });
    const updatedListbox = within(updatedPicker).getByRole('listbox', { name: 'Suggestions' });
    const updatedGroup = within(updatedListbox)
      .getByText('Profile', { selector: '[cmdk-group-heading]' })
      .closest('[cmdk-group]');
    if (!(updatedGroup instanceof HTMLElement))
      throw new Error('Expected the updated profile options group');
    const updatedOption = within(updatedGroup).getByRole('option', {
      name: new RegExp(targetProfile.name),
    });
    expect(updatedOption.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the Auto option in a stable position through quota and session events', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('Expected a fixture session');
    const model = (await client.models.list())[0];
    if (!model) throw new Error('Expected a fixture model');
    const listeners = new Map<keyof FerryEvents, ((payload: unknown) => void)[]>();
    const eventClient = {
      ...client,
      on: ((event: keyof FerryEvents, handler: (payload: never) => void) => {
        const eventListeners = listeners.get(event) ?? [];
        eventListeners.push(handler as (payload: unknown) => void);
        listeners.set(event, eventListeners);
        return () => undefined;
      }) as typeof client.on,
    };
    const emit = <Event extends keyof FerryEvents>(event: Event, payload: FerryEvents[Event]) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    };

    function EventBridge({ children }: { children: ReactNode }) {
      const [, setEventCount] = useState(0);
      useEffect(() => {
        const offQuota = eventClient.on('quota.updated', () => {
          setEventCount((count) => count + 1);
        });
        const offStatus = eventClient.on('session.status', () => {
          setEventCount((count) => count + 1);
        });
        return () => {
          offQuota();
          offStatus();
        };
      }, [eventClient]);
      useFerryEvents();
      return <>{children}</>;
    }

    render(
      <FerryProvider client={eventClient}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <EventBridge>
            <ComposerModelChip sessionId={session.id} modelName={model.name} mode="manual" />
          </EventBridge>
        </QueryClientProvider>
      </FerryProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: model.name }));
    const autoLabel = await screen.findByText('Auto (recommended)');
    const autoOption = autoLabel.closest('[role="option"]');
    if (!autoOption) throw new Error('Expected the Auto model option');
    const rects: number[][] = [];
    const quota = await client.quota.capacity();
    const status = (await client.sessions.get(session.id)).session;
    for (let frame = 0; frame < 10; frame += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      const rect = autoOption.getBoundingClientRect();
      rects.push([rect.x, rect.y, rect.width, rect.height]);
      if (frame === 2 || frame === 5 || frame === 8) {
        act(() => {
          emit('quota.updated', quota);
          emit('session.status', status);
        });
      }
    }
    expect(rects).toHaveLength(10);
    expect(rects.every((rect) => rect.every((value, index) => value === rects[0]?.[index]))).toBe(
      true,
    );
  });

  it('switches Manual to Auto by mouse and back to Manual by keyboard', async () => {
    const user = userEvent.setup();
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
    const profiles = await client.profiles.list();
    const activeProfile = profiles.find((profile) => profile.id === session.profileId);
    if (!activeProfile) throw new Error('Expected the fixture session profile');
    const activeProfileId = activeProfile.id;
    const activeProfileName = activeProfile.name;

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
        <ComposerModelChip
          sessionId={session.id}
          profiles={profiles}
          activeProfileId={activeProfileId}
          profileName={activeProfileName}
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
    fireEvent.click(screen.getByRole('button', { name: autoModel.name }));
    const picker = await screen.findByRole('dialog', { name: 'Choose model' });
    const autoOption = within(picker).getByRole('option', { name: /Auto \(recommended\)/ });
    await user.click(autoOption);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: `Auto · ${autoModel.name}` })).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Auto · / }));
    const keyboardPicker = await screen.findByRole('dialog', { name: 'Choose model' });
    const search = within(keyboardPicker).getByRole('combobox', { name: 'Choose model' });
    const listbox = within(keyboardPicker).getByRole('listbox', { name: 'Suggestions' });
    const manualOption = within(listbox)
      .getAllByRole('option')
      .find(
        (option) =>
          !option.classList.contains('auto') &&
          !option.getAttribute('data-value')?.startsWith('profile '),
      );
    if (!manualOption) throw new Error('Expected a provider model option after the profile group');
    const manualNameElement = manualOption.querySelector('strong');
    if (!manualNameElement) throw new Error('Expected a manual model name');
    const manualName = manualNameElement.firstChild?.textContent?.trim() ?? '';
    await user.type(search, manualName);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      const trigger = screen.getByRole('button', { name: manualName });
      expect(trigger).toBeTruthy();
      expect(trigger.textContent).toContain(manualName);
      expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull();
    });
  });

  it('runs a command palette action from the keyboard', async () => {
    const user = userEvent.setup();
    const client = createMockFerryClient({ behavior: 'test' });
    render(
      <FerryProvider client={client}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <CommandPalette onNewChat={() => Promise.resolve()} />
        </QueryClientProvider>
      </FerryProvider>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await user.click(await screen.findByText('Toggle density (comfortable)'));
    await waitFor(() => {
      expect(useUI.getState().density).toBe('compact');
    });
    cleanup();
    useUI.getState().setDensity('comfortable');
  });

  it('delegates New Chat to the shared handler', async () => {
    const onNewChat = vi.fn(() => Promise.resolve());
    const client = createMockFerryClient({ behavior: 'test' });
    render(
      <FerryProvider client={client}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <CommandPalette onNewChat={onNewChat} />
        </QueryClientProvider>
      </FerryProvider>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '> New Chat' } });
    fireEvent.click(await screen.findByRole('option', { name: /^New Chat$/ }));
    await waitFor(() => {
      expect(onNewChat).toHaveBeenCalledOnce();
    });
  });

  it('keeps focus on the composer after the palette creates a chat', async () => {
    function NewChatFocusHarness() {
      const [created, setCreated] = useState(false);
      const pendingComposerFocus = useUI((state) => state.pendingComposerFocus);
      return (
        <>
          <CommandPalette
            onNewChat={() => {
              setCreated(true);
              useUI.getState().requestComposerFocus();
              return Promise.resolve();
            }}
          />
          {created ? (
            <Composer
              value=""
              onChange={() => undefined}
              onSend={() => undefined}
              onStop={() => undefined}
              running={false}
              profileName="Auto-Free"
              focusRequested={pendingComposerFocus}
              onFocusRequestConsumed={() => {
                useUI.getState().consumeComposerFocus();
              }}
            />
          ) : null}
        </>
      );
    }

    const client = createMockFerryClient({ behavior: 'test' });
    render(
      <FerryProvider client={client}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <NewChatFocusHarness />
        </QueryClientProvider>
      </FerryProvider>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '> New Chat' } });
    fireEvent.click(await screen.findByRole('option', { name: /^New Chat$/ }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message Ferry' }));
    });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
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
          <CommandPalette onNewChat={() => Promise.resolve()} />
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
