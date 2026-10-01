import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockFerryClient } from '@ferry/client';
import type {
  CheckpointId,
  Message,
  MessagePart,
  ModelRef,
  RunId,
  SessionDetail,
} from '@ferry/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useFerryEvents } from '../data/events';
import { keys } from '../data/queries';
import { useUI } from '../state/ui';
import { HomeCanvas, PartView } from './Canvas';
import { sampleDelegationRun, sampleSession } from '@ferry/shared/testing';

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

function EventBridge() {
  useFerryEvents();
  return null;
}

function mount(ui: React.ReactNode, client = createMockFerryClient({ behavior: 'test' })) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queries}>
        <EventBridge />
        {ui}
      </QueryClientProvider>
    </FerryProvider>,
  );
  return { ...result, client, queries };
}

afterEach(() => {
  cleanup();
  navigateMock.mockReset();
  useUI.setState({
    tabs: [],
    activeId: null,
    leftCollapsed: false,
    rightCollapsed: false,
    rightTab: 'chats',
    density: 'comfortable',
  });
});

describe('Home and session canvases', () => {
  it('renders every persisted chat part after the structured event migration', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const delegated = {
      ...sampleDelegationRun,
      sessionId: sampleSession.id,
      id: 'run_00000000000000000000' as RunId,
      lane: 'Codex lane',
      progress: [{ at: '2026-09-30T10:00:00.000Z', text: 'Structured event summary' }],
    };
    vi.spyOn(client.delegation, 'runs').mockResolvedValue([delegated]);
    const parts: MessagePart[] = [
      { type: 'text', id: 'part_text' as MessagePart['id'], text: 'Transcript text survives' },
      {
        type: 'reasoning',
        id: 'part_reasoning' as MessagePart['id'],
        text: 'Reasoning survives',
      },
      {
        type: 'tool_call',
        id: 'part_tool' as MessagePart['id'],
        tool: 'shell',
        title: 'Run checks',
        args: { command: 'pnpm check' },
        status: 'succeeded',
        output: {
          text: 'Checks complete',
          filtered: false,
          originalTokens: null,
          filteredTokens: null,
          recoveryHandle: null,
        },
        changes: [],
        durationMs: 12,
      },
      {
        type: 'approval_request',
        id: 'part_approval' as MessagePart['id'],
        kind: 'command',
        summary: 'Approve command',
        detail: 'pnpm check',
        risk: 'low',
        state: 'pending',
      },
      {
        type: 'handoff_marker',
        id: 'part_handoff' as MessagePart['id'],
        from: 'openai/gpt-5' as ModelRef,
        to: 'anthropic/claude-sonnet' as ModelRef,
        reason: 'rate_limit',
        briefingTokens: 1200,
        explanation: 'The current provider is rate limited.',
      },
      {
        type: 'delegation',
        id: 'part_delegation' as MessagePart['id'],
        runId: delegated.id,
      },
      {
        type: 'checkpoint',
        id: 'part_checkpoint' as MessagePart['id'],
        checkpointId: 'checkpoint_00000000000000000000' as CheckpointId,
        label: 'Before edits',
      },
      {
        type: 'error',
        id: 'part_error' as MessagePart['id'],
        kind: 'tool',
        message: 'Tool failed safely',
      },
    ];
    mount(
      <>
        {parts.map((part) => (
          <PartView
            key={part.id}
            part={part}
            sessionId={sampleSession.id}
            canRetry={false}
            onPickAnother={() => undefined}
            onFull={() => undefined}
            onDiff={() => undefined}
            onReview={() => undefined}
            onCancel={() => undefined}
          />
        ))}
      </>,
      client,
    );

    expect(screen.getByText('Transcript text survives')).toBeTruthy();
    fireEvent.click(screen.getByText('Thinking'));
    expect(screen.getByText('Reasoning survives')).toBeTruthy();
    expect(screen.getByText('Run checks')).toBeTruthy();
    expect(screen.getByText('Approve command')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Switched from .*rate_limit/ })).toBeTruthy();
    expect(await screen.findByText('Structured event summary')).toBeTruthy();
    expect(screen.getByText('Checkpoint · Before edits')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Tool failed safely');
  });

  it('patches a sent message into cached session detail without refetching the transcript', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const { queries } = mount(<div />, client);
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('Expected a fixture session');
    const detail = await client.sessions.get(session.id);
    queries.setQueryData(keys.session(session.id), detail);
    const getSession = vi.spyOn(client.sessions, 'get');

    await client.sessions.send(session.id, { text: 'Append without transcript refetch' });

    await waitFor(() => {
      expect(queries.getQueryData<SessionDetail>(keys.session(session.id))?.messages).toHaveLength(
        detail.messages.length + 1,
      );
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('applies a handoff part event that arrives before its assistant message event', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const on = ((event: string, handler: (payload: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set<(payload: unknown) => void>();
      eventListeners.add(handler);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(handler);
    }) as typeof client.on;
    const eventClient = Object.assign(client, { on });
    const { queries } = mount(<div />, eventClient);
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('Expected a fixture session');
    const detail = await client.sessions.get(session.id);
    queries.setQueryData(keys.session(session.id), detail);
    const message: Message = {
      id: 'msg_handoff_event' as Message['id'],
      sessionId: session.id,
      role: 'assistant',
      createdAt: new Date().toISOString(),
      modelRef: null,
      parts: [],
    };
    const handoffPart: Extract<MessagePart, { type: 'handoff_marker' }> = {
      type: 'handoff_marker',
      id: 'part_handoff_event' as MessagePart['id'],
      from: 'groq/qwen/qwen3.6-27b' as Extract<MessagePart, { type: 'handoff_marker' }>['from'],
      to: 'openrouter/cohere/north-mini-code:free' as Extract<
        MessagePart,
        { type: 'handoff_marker' }
      >['to'],
      reason: 'rate_limit',
      briefingTokens: 120,
      explanation: 'Provider returned HTTP 429; continuing with a fallback model.',
    };
    const emit = (event: string, payload: unknown) => {
      listeners.get(event)?.forEach((handler) => {
        handler(payload);
      });
    };

    emit('session.part', { sessionId: session.id, messageId: message.id, part: handoffPart });
    emit('session.message', { sessionId: session.id, message });

    const updated = queries.getQueryData<SessionDetail>(keys.session(session.id));
    expect(updated?.messages.find((item) => item.id === message.id)?.parts).toContainEqual(
      handoffPart,
    );
  });

  it('creates, sends, opens a tab, and navigates from the Home composer', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    mount(<HomeCanvas />, client);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message Ferry' }), {
      target: { value: 'Explain the router' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(async () => {
      const sessions = await client.sessions.list();
      expect(sessions.some((session) => session.preview === 'Explain the router')).toBe(true);
      expect(useUI.getState().tabs).toHaveLength(1);
      const sessionId = useUI.getState().tabs[0]?.id;
      expect(sessionId).toBeTruthy();
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/s/$sessionId',
        params: { sessionId },
      });
    });
  });
});
