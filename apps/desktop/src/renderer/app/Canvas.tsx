import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  AgentEvent,
  MessagePart,
  Provider,
  RunId,
  SessionDetail,
  SessionId,
} from '@ferry/shared';
import {
  ApprovalCard,
  AgentTimeline,
  AssistantMessage,
  CanvasHeaderActions,
  CanvasPanel,
  CheckpointMarker,
  Composer,
  ContinueRow,
  DelegationCard,
  Disclaimer,
  EmptyState,
  Skeleton,
  ErrorPart,
  Hero,
  HandoffMarker,
  MarkdownPart,
  ModelPickerTrigger,
  PinnedChatsRow,
  ReasoningPart,
  StreamingCursor,
  SuggestionChips,
  ToolCallBlock,
  ToolStepGroup,
  dataUseStatus,
  groupParts,
  UserMessage,
} from '@ferry/ui';
import { GitBranch } from 'lucide-react';
import { useFerryClient } from '../data/client';
import { listAllModels } from '@ferry/client';
import {
  keys,
  useCapacity,
  useProfiles,
  useSessionDetail,
  useSessions,
  useSettings,
  useWorkspaces,
} from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import { ModelPickerPopover } from './SessionPowerControls';
import { FullOutputDialog } from './FullOutputDialog';

const starters: Record<string, string> = {
  'Explain this repo': 'Explain how this repository is structured and where the main flows live.',
  'Fix failing tests': 'Find and fix the failing tests in this repo.',
  'Write tests': 'Add focused tests for the behavior that is currently missing.',
  Refactor: 'Refactor the selected code while preserving its current behavior.',
  'Review my changes': 'Review my current changes for bugs and missing tests.',
  'Plan a feature': 'Help me plan this feature and identify the files it will touch.',
};
const warnedOAuthRuns = new Set<string>();
const warnedTrainingSessions = new Set<string>();

function warnOAuthUseOnce(
  _runId: string,
  modelRef: string | null,
  pushToast: (toast: { kind: 'warning'; title: string; body: string }) => void,
) {
  const provider = modelRef?.split('/')[0];
  if (
    !modelRef ||
    !provider ||
    !['anthropic', 'openai-codex', 'github-copilot'].includes(provider) ||
    warnedOAuthRuns.has('app-run')
  )
    return;
  warnedOAuthRuns.add('app-run');
  pushToast({
    kind: 'warning',
    title: 'Subscription OAuth account risk',
    body: 'This model uses an unofficial subscription login. The provider may suspend or ban your account.',
  });
}

function warnTrainingUseOnce(
  sessionId: string,
  modelRef: string | null,
  models: readonly { ref: string; free: boolean }[],
  providers: readonly Provider[],
  pushToast: (toast: { kind: 'warning'; title: string; body: string }) => void,
) {
  if (!modelRef || !models.some((model) => model.ref === modelRef && model.free)) return;
  const providerId = modelRef.split('/')[0];
  const provider = providers.find((item) => item.id === providerId);
  if (!provider || dataUseStatus(provider.dataUse) !== 'training') return;
  const key = `ferry.training-notice.${sessionId}`;
  if (warnedTrainingSessions.has(sessionId) || localStorage.getItem(key)) return;
  warnedTrainingSessions.add(sessionId);
  localStorage.setItem(key, 'shown');
  pushToast({
    kind: 'warning',
    title: 'Free lane data-use notice',
    body: `${provider.name} may use prompts to train or improve its services. Review provider terms before sharing sensitive code.`,
  });
}

function shortModel(
  ref: string | null | undefined,
  models: { ref: string; name: string }[],
): string {
  if (!ref) return models[0]?.name.split(' ').slice(-1)[0] ?? 'GLM-5.3';
  const model = models.find((item) => item.ref === ref);
  return model?.name ?? ref.split('/').at(-1) ?? ref;
}

function relativeDate(value: string): string {
  const delta = Math.max(0, Date.now() - new Date(value).getTime());
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) return `${String(Math.floor(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${String(Math.floor(delta / 3_600_000))}h ago`;
  return `${String(Math.floor(delta / 86_400_000))}d ago`;
}

function timelineEventsByTurn(
  messages: SessionDetail['messages'],
  events: AgentEvent[],
): Map<number, AgentEvent[]> {
  const result = new Map<number, AgentEvent[]>();
  const turns: { start: number; end: number; assistant: number }[] = [];
  let turnStart: number | null = null;
  let lastAssistant = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'user') {
      if (turnStart !== null && lastAssistant >= 0)
        turns.push({
          start: turnStart,
          end: Date.parse(message.createdAt),
          assistant: lastAssistant,
        });
      turnStart = Date.parse(message.createdAt);
      lastAssistant = -1;
    } else lastAssistant = index;
  }
  if (turnStart !== null && lastAssistant >= 0)
    turns.push({ start: turnStart, end: Number.POSITIVE_INFINITY, assistant: lastAssistant });
  const orderedEvents = events
    .map((event) => ({ event, at: Date.parse(event.timestamp) }))
    .sort((left, right) => left.at - right.at);
  let eventIndex = 0;
  for (const turn of turns) {
    while (eventIndex < orderedEvents.length) {
      const item = orderedEvents[eventIndex];
      if (!item || item.at >= turn.start) break;
      eventIndex += 1;
    }
    const turnEvents: AgentEvent[] = [];
    while (eventIndex < orderedEvents.length) {
      const item = orderedEvents[eventIndex];
      if (!item || item.at >= turn.end) break;
      turnEvents.push(item.event);
      eventIndex += 1;
    }
    if (turnEvents.length) result.set(turn.assistant, turnEvents);
  }
  return result;
}

function captureTranscriptAnchor(
  element: HTMLDivElement | null,
): { index: number; offset: number } | null {
  if (!element) return null;
  const firstVisible = [...element.querySelectorAll<HTMLElement>('.transcript-message')].find(
    (message) => message.getBoundingClientRect().bottom > element.getBoundingClientRect().top,
  );
  if (!firstVisible) return null;
  return {
    index: Number(firstVisible.dataset.index),
    offset: firstVisible.getBoundingClientRect().top - element.getBoundingClientRect().top,
  };
}

const streamedTextByPart = new Map<string, string>();
const streamedTextListeners = new Map<string, Set<() => void>>();

function publishStreamedText(partId: string, delta: string): void {
  streamedTextByPart.set(partId, `${streamedTextByPart.get(partId) ?? ''}${delta}`);
  streamedTextListeners.get(partId)?.forEach((listener) => {
    listener();
  });
}

function clearStreamedText(partId: string): void {
  streamedTextByPart.delete(partId);
  streamedTextListeners.get(partId)?.forEach((listener) => {
    listener();
  });
}

function useStreamedText(partId: string | null): string | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!partId) return () => undefined;
      const listeners = streamedTextListeners.get(partId) ?? new Set<() => void>();
      listeners.add(listener);
      streamedTextListeners.set(partId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) streamedTextListeners.delete(partId);
      };
    },
    [partId],
  );
  const getSnapshot = useCallback(
    () => (partId ? (streamedTextByPart.get(partId) ?? null) : null),
    [partId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function HomeCanvas() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const pushToast = useToasts((state) => state.push);
  const openTab = useUI((state) => state.openTab);
  const { data: sessions = [], isLoading: sessionsLoading } = useSessions();
  const { data: workspaces = [] } = useWorkspaces();
  const { data: profiles = [] } = useProfiles();
  const { data: settings } = useSettings();
  const { data: capacity } = useCapacity();
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => listAllModels(client),
  });
  const { data: candidates = [] } = useQuery({
    queryKey: ['model-candidates', null],
    queryFn: () => client.models.candidates(null),
  });
  const [prompt, setPrompt] = useState('');
  const activeProfile = profiles.find((profile) => profile.id === settings?.activeProfileId);
  const pinned = sessions.filter((session) => session.pinned).slice(0, 5);
  const recent = [...sessions]
    .filter((session) => session.status !== 'error')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  const compactHome =
    !sessionsLoading &&
    sessions.length > 0 &&
    settings?.homeStyle !== 'hero' &&
    (settings?.homeStyle === 'compact' || sessions.length >= 3 || settings?.onboardingComplete);
  const send = async () => {
    const text = prompt.trim();
    const workspace = workspaces[0];
    if (!text || !workspace) return;
    const session = await client.sessions.create({
      workspaceId: workspace.id,
      ...(settings?.activeProfileId ? { profileId: settings.activeProfileId } : {}),
    });
    openTab({ id: session.id, title: session.title });
    warnOAuthUseOnce(`app:${session.id}`, session.modelRef, pushToast);
    try {
      await client.sessions.send(session.id, { text });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Message could not be sent',
        body: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    await cache.invalidateQueries({ queryKey: keys.sessions });
    setPrompt('');
    await navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
  };
  const cycleProfile = async () => {
    const pinnedProfiles = profiles.filter((profile) => profile.pinned);
    if (!pinnedProfiles.length) return;
    const current = pinnedProfiles.findIndex((profile) => profile.id === settings?.activeProfileId);
    const next = pinnedProfiles[(current + 1) % pinnedProfiles.length];
    if (!next) return;
    await client.profiles.activate(next.id);
    await cache.invalidateQueries({ queryKey: keys.profiles });
    await cache.invalidateQueries({ queryKey: keys.settings });
  };
  const go = (id: SessionId, title: string) => {
    openTab({ id, title });
    void navigate({ to: '/s/$sessionId', params: { sessionId: id } });
  };
  return (
    <CanvasPanel
      header={
        <>
          <ModelPickerTrigger mode="auto" modelName={shortModel(candidates[0]?.ref, models)} />
          <CanvasHeaderActions
            onMore={() => {
              pushToast({
                kind: 'info',
                title: 'Canvas actions',
                body: 'More actions are coming later.',
              });
            }}
            onLink={() => {
              void navigator.clipboard.writeText(window.location.href);
            }}
            onShare={() => {
              pushToast({ kind: 'info', title: 'Share', body: 'There is nothing to share yet.' });
            }}
          />
        </>
      }
      className="home-canvas"
    >
      <div className={`home-content${compactHome ? ' home-content-compact' : ''}`}>
        {!compactHome && (
          <Hero
            title={['Build bigger with Ferry,', 'every free model, one seamless task.']}
            subtitle="Ferry routes each step to the model that still has room, and carries your task across when one runs dry."
          />
        )}
        {sessionsLoading ? (
          <Skeleton rows={2} />
        ) : (
          sessions.length === 0 && (
            <EmptyState
              title="No sessions yet"
              action="Start your first chat"
              onAction={() =>
                document.querySelector<HTMLTextAreaElement>('[aria-label="Message Ferry"]')?.focus()
              }
            />
          )
        )}
        {capacity?.stepsLeftToday === 0 && (
          <div className="capacity-exhausted">
            <div>
              <strong>All free capacity is used</strong>
              <span>Earliest reset in 2h 13m.</span>
            </div>
            <button onClick={() => void navigate({ to: '/explore' })}>Add provider</button>
          </div>
        )}
        {compactHome && (
          <div className="home-composer-slot">
            <Composer
              value={prompt}
              onChange={setPrompt}
              onSend={() => void send()}
              onStop={() => undefined}
              running={false}
              banner={
                capacity?.banner
                  ? {
                      text: capacity.banner.text,
                      actionLabel: capacity.banner.actionLabel,
                      onAction: () =>
                        void navigate({
                          to:
                            capacity.banner?.action === 'open_usage'
                              ? '/explore/usage'
                              : '/explore',
                        }),
                    }
                  : null
              }
              profileName={activeProfile?.name ?? 'Best Available'}
              onProfileClick={() => void cycleProfile()}
              onAttach={() => {
                pushToast({ kind: 'info', title: 'Attachments arrive later', body: null });
              }}
            />
          </div>
        )}
        {compactHome && (
          <div className="home-continue-slot">
            <ContinueRow
              cards={recent.map((session) => ({
                language:
                  workspaces.find((workspace) => workspace.id === session.workspaceId)?.language ??
                  'other',
                title: session.title,
                snippet: session.preview,
                date: relativeDate(session.updatedAt),
                status: session.status,
                repo:
                  workspaces.find((workspace) => workspace.id === session.workspaceId)?.name ??
                  'Workspace',
                onClick: () => {
                  go(session.id, session.title);
                },
              }))}
            />
          </div>
        )}
        <div className="home-pinned-slot">
          <PinnedChatsRow
            cards={pinned.map((session) => ({
              language:
                workspaces.find((workspace) => workspace.id === session.workspaceId)?.language ??
                'other',
              title: session.title,
              snippet: session.preview,
              date: relativeDate(session.updatedAt),
              onClick: () => {
                go(session.id, session.title);
              },
            }))}
            onSeeAll={() => void navigate({ to: '/library' })}
          />
        </div>
        <div className="home-chips-slot">
          <SuggestionChips
            onSelect={(label) => {
              setPrompt(starters[label] ?? label);
            }}
          />
        </div>
        {!compactHome && (
          <Composer
            value={prompt}
            onChange={setPrompt}
            onSend={() => void send()}
            onStop={() => undefined}
            running={false}
            banner={
              capacity?.banner
                ? {
                    text: capacity.banner.text,
                    actionLabel: capacity.banner.actionLabel,
                    onAction: () =>
                      void navigate({
                        to:
                          capacity.banner?.action === 'open_usage' ? '/explore/usage' : '/explore',
                      }),
                  }
                : null
            }
            profileName={activeProfile?.name ?? 'Best Available'}
            onProfileClick={() => void cycleProfile()}
            onAttach={() => {
              pushToast({ kind: 'info', title: 'Attachments arrive later', body: null });
            }}
          />
        )}
        <div className="home-disclaimer-slot">
          <Disclaimer />
        </div>
      </div>
    </CanvasPanel>
  );
}

export function PartView({
  part,
  sessionId,
  canRetry,
  isStreaming = false,
  onPickAnother,
  onFull,
  onDiff,
  onReview,
  onCancel,
}: {
  part: MessagePart;
  sessionId: SessionId;
  canRetry: boolean;
  isStreaming?: boolean;
  onPickAnother: () => void;
  onFull: (handle: string) => void;
  onDiff: () => void;
  onReview: (id: RunId) => void;
  onCancel: (id: RunId) => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const pushToast = useToasts((state) => state.push);
  const retryLastPrompt = async (routingMode?: 'auto_for_step') => {
    try {
      const detail = await client.sessions.get(sessionId);
      const lastUserMessage = detail.messages.filter((message) => message.role === 'user').at(-1);
      const text = lastUserMessage?.parts
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      if (!text) return;
      await client.sessions.send(sessionId, { text, ...(routingMode ? { routingMode } : {}) });
      await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Retry failed',
        body: error instanceof Error ? error.message : 'Try again or choose a different model.',
      });
    }
  };
  switch (part.type) {
    case 'text':
      return isStreaming ? (
        <div className="whitespace-pre-wrap break-words">
          {part.text}
          <StreamingCursor />
        </div>
      ) : (
        <MarkdownPart content={part.text} />
      );
    case 'reasoning':
      return <ReasoningPart text={part.text} />;
    case 'tool_call':
      return (
        <ToolCallBlock
          {...part}
          onShowFull={(handle) => {
            onFull(handle);
          }}
          onOpenDiff={onDiff}
        />
      );
    case 'approval_request':
      return (
        <ApprovalCard
          {...part}
          onRespond={(decision) => {
            const mapped = decision === 'always_allow' ? 'allow_always' : decision;
            const nextState =
              mapped === 'deny'
                ? 'denied'
                : mapped === 'allow_once'
                  ? 'allowed_once'
                  : 'allowed_always';
            cache.setQueryData<SessionDetail>(keys.session(sessionId), (current) =>
              current
                ? {
                    ...current,
                    messages: current.messages.map((message) => ({
                      ...message,
                      parts: message.parts.map((candidate) =>
                        candidate.id === part.id && candidate.type === 'approval_request'
                          ? { ...candidate, state: nextState }
                          : candidate,
                      ),
                    })),
                  }
                : current,
            );
            void client.approvals.respond(sessionId, part.id, mapped).catch(async () => {
              await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
            });
          }}
        />
      );
    case 'handoff_marker':
      return (
        <HandoffMarker
          from={part.from}
          to={part.to}
          reason={part.reason}
          briefingTokens={part.briefingTokens}
          explanation={part.explanation}
        />
      );
    case 'delegation':
      return (
        <DelegationRunView
          sessionId={sessionId}
          runId={part.runId}
          onReview={() => {
            onReview(part.runId);
          }}
          onCancel={onCancel}
          onFull={onFull}
        />
      );
    case 'checkpoint':
      return (
        <CheckpointMarker
          label={part.label}
          onRestore={() => {
            void client.checkpoints.restore(part.checkpointId);
          }}
        />
      );
    case 'error': {
      const presentation = getErrorPresentation(part);
      const paidCapReached = part.message.startsWith('Paid cap reached:');
      return (
        <div className="space-y-2">
          <ErrorPart
            message={presentation.summary}
            attempts={presentation.attempts}
            onRetry={
              !paidCapReached && canRetry && !presentation.allExhausted
                ? () => void retryLastPrompt()
                : undefined
            }
            onSwitchToAuto={
              !paidCapReached && canRetry ? () => void retryLastPrompt('auto_for_step') : undefined
            }
            onPickModel={!paidCapReached && canRetry ? onPickAnother : undefined}
            onWait={
              paidCapReached
                ? () => void retryLastPrompt('auto_for_step')
                : canRetry && presentation.allExhausted
                  ? () => {
                      const minutes = Number(
                        /in (\d+) min/i.exec(presentation.nextCapacity ?? '')?.[1] ?? 0,
                      );
                      window.setTimeout(
                        () => void retryLastPrompt('auto_for_step'),
                        Math.max(60_000, minutes * 60_000),
                      );
                      pushToast({
                        kind: 'info',
                        title: 'Retry scheduled',
                        body: presentation.nextCapacity ?? 'The next free reset.',
                      });
                    }
                  : undefined
            }
            waitLabel={paidCapReached ? 'Wait for free capacity' : undefined}
            onRaiseCap={paidCapReached ? () => void navigate({ to: '/settings' }) : undefined}
            onStop={paidCapReached ? () => void client.sessions.cancel(sessionId) : undefined}
            onAddProvider={
              !paidCapReached && presentation.allExhausted
                ? () => void navigate({ to: '/explore' })
                : undefined
            }
          />
          {presentation.summary.startsWith('No available model —') ? (
            <button
              className="rounded-md bg-blue-tint px-3 py-1.5 text-label font-medium text-link"
              onClick={() => void navigate({ to: '/explore' })}
              type="button"
            >
              Explore providers
            </button>
          ) : null}
        </div>
      );
    }
  }
}

function getErrorPresentation(part: MessagePart & { type: 'error' }): {
  summary: string;
  attempts: { model: string; kind: string; status: string; message: string }[];
  allExhausted: boolean;
  nextCapacity: string | null;
} {
  const raw = part as unknown as Record<string, unknown>;
  const safeText = (value: unknown, fallback: string): string => {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !text.trim()) return fallback;
    const cleaned = text
      .replace(/\s+(?:Attempted:|Ranked candidates:|Provider detail:)[\s\S]*$/i, '')
      .replace(/\s+\{[\s\S]*$/, '')
      .replace(/\s+\[[\s\S]*$/, '')
      .trim();
    if (!cleaned || cleaned.startsWith('{') || cleaned.startsWith('[')) return fallback;
    return cleaned.length > 240 ? `${cleaned.slice(0, 237).trimEnd()}…` : cleaned;
  };
  const summary = safeText(
    raw.summary,
    safeText(raw.message, 'The model could not complete this step.'),
  );
  const rawDetails = raw.details;
  const rawAttempts =
    rawDetails && typeof rawDetails === 'object' && 'attempts' in rawDetails
      ? (rawDetails as { attempts?: unknown }).attempts
      : undefined;
  const attempts = Array.isArray(rawAttempts)
    ? rawAttempts.flatMap(
        (
          attempt,
        ): {
          model: string;
          kind: string;
          status: string;
          message: string;
          provider?: string;
          latencyMs?: number;
        }[] => {
          if (!attempt || typeof attempt !== 'object') return [];
          const item = attempt as Record<string, unknown>;
          return [
            {
              model: safeText(item.model ?? item.modelRef, 'Unknown model'),
              kind: safeText(item.kind ?? item.errorKind, 'Error'),
              status: safeText(item.status ?? item.statusCode, 'Failed'),
              message: safeText(item.message ?? item.shortMessage, 'No additional detail.'),
              ...(typeof item.provider === 'string' ? { provider: item.provider } : {}),
              ...(typeof item.latencyMs === 'number' ? { latencyMs: item.latencyMs } : {}),
            },
          ];
        },
      )
    : [];
  const details = raw.details && typeof raw.details === 'object' ? raw.details : null;
  return {
    summary,
    attempts,
    allExhausted: raw.kind === 'all_candidates_exhausted',
    nextCapacity:
      details && 'nextCapacity' in details && typeof details.nextCapacity === 'string'
        ? details.nextCapacity
        : null,
  };
}

function DelegationRunView({
  sessionId,
  runId,
  onReview,
  onCancel,
  onFull,
}: {
  sessionId: SessionId;
  runId: string;
  onReview: (id: RunId) => void;
  onCancel: (id: RunId) => void;
  onFull: (handle: string) => void;
}) {
  const client = useFerryClient();
  const { data: runs = [] } = useQuery({
    queryKey: ['delegation', sessionId],
    queryFn: () => client.delegation.runs(sessionId),
  });
  const run = runs.find((item) => item.id === runId);
  if (!run) return <div className="text-label text-text-3">Loading delegated work…</div>;
  return (
    <DelegationCard
      lane={run.lane}
      implementer={run.implementer}
      status={run.status}
      progress={run.progress.at(-1)?.text ?? 'Working'}
      usage={
        run.usage
          ? `${String(run.usage.inputTokens + run.usage.outputTokens)} tokens`
          : 'Usage updating'
      }
      events={run.events}
      onShowFull={onFull}
      onReviewDiff={() => {
        onReview(run.id);
      }}
      onCancel={() => {
        onCancel(run.id);
      }}
    />
  );
}

const TranscriptMessageRow = memo(function TranscriptMessageRow({
  message,
  index,
  top,
  modelName,
  planSteps,
  timelineEvents,
  sessionId,
  canRetry,
  streamPartId,
  onFullOutput,
  onPickModel,
  measureElement,
}: {
  message: SessionDetail['messages'][number];
  index: number;
  top: number;
  modelName: string;
  planSteps: { label: string; status: 'done' | 'active' | 'pending' }[];
  timelineEvents: AgentEvent[];
  sessionId: SessionId;
  canRetry: boolean;
  streamPartId: string | null;
  onFullOutput: (handle: string) => void;
  onPickModel: () => void;
  measureElement: (element: HTMLElement | null) => void;
}) {
  const client = useFerryClient();
  const navigate = useNavigate();
  const setRightTab = useUI((state) => state.setRightTab);
  const streamingText = useStreamedText(streamPartId);
  const streamingPartIsInMessage =
    streamPartId !== null && message.parts.some((part) => part.id === streamPartId);
  const timelineHasTools = timelineEvents.some((event) => event.type === 'tool_use');
  const timelineHasThinking = timelineEvents.some((event) => event.type === 'thinking');
  const timelineHasText = timelineEvents.some((event) => event.type === 'text');
  return (
    <div
      className="transcript-message"
      data-index={index}
      ref={measureElement}
      style={{
        position: 'absolute',
        top: 0,
        left: '50%',
        width: 'min(760px, 100%)',
        transform: `translate(-50%, ${String(top)}px)`,
      }}
    >
      {message.role === 'user' ? (
        <UserMessage>
          {message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')}
        </UserMessage>
      ) : (
        <AssistantMessage
          modelName={modelName}
          {...(message.agentRole ? { agentRole: message.agentRole } : {})}
        >
          <AgentTimeline
            events={timelineEvents}
            {...(timelineEvents.length
              ? {
                  onShowFull: (handle: string) => {
                    onFullOutput(handle);
                  },
                }
              : {})}
          />
          {groupParts(message.parts).map((part) => {
            if (
              (timelineHasTools && (part.type === 'tool_group' || part.type === 'tool_call')) ||
              (timelineHasThinking && part.type === 'reasoning') ||
              (timelineHasText && part.type === 'text')
            )
              return null;
            return part.type === 'tool_group' ? (
              <ToolStepGroup
                key={part.parts[0]?.id ?? 'tool-group'}
                parts={part.parts}
                onShowFull={onFullOutput}
                onOpenDiff={() => {
                  setRightTab('changes');
                }}
              />
            ) : part.type === 'reasoning' ? (
              <ReasoningPart key={part.id} text={part.text} steps={planSteps} />
            ) : (
              <PartView
                key={part.id}
                part={part}
                sessionId={sessionId}
                canRetry={canRetry}
                isStreaming={part.id === streamPartId}
                onFull={onFullOutput}
                onDiff={() => {
                  setRightTab('changes');
                }}
                onReview={(runId) =>
                  void navigate({ to: '/s/$sessionId/review/$runId', params: { sessionId, runId } })
                }
                onCancel={(id) => void client.delegation.cancel(id)}
                onPickAnother={onPickModel}
              />
            );
          })}
          {streamingText !== null && !streamingPartIsInMessage && (
            <div className="whitespace-pre-wrap break-words">
              {streamingText}
              <StreamingCursor />
            </div>
          )}
          {streamingText !== null && streamingPartIsInMessage && <StreamingCursor />}
        </AssistantMessage>
      )}
    </div>
  );
});

export function SessionCanvas() {
  const { sessionId: rawId } = useParams({ from: '/s/$sessionId' });
  const sessionId = rawId as SessionId;
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const pushToast = useToasts((state) => state.push);
  const density = useUI((state) => state.density);
  const pendingComposerFocus = useUI((state) => state.pendingComposerFocus);
  const { data, isLoading, isError } = useSessionDetail(sessionId);
  const { data: workspaces = [] } = useWorkspaces();
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => listAllModels(client),
  });
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: profiles = [] } = useProfiles();
  const [prompt, setPrompt] = useState('');
  useEffect(() => {
    if (!pendingComposerFocus) return;
    document.querySelector<HTMLTextAreaElement>('[aria-label="Message Ferry"]')?.focus();
    useUI.getState().consumeComposerFocus();
  }, [pendingComposerFocus, sessionId]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const openModelPicker = useCallback(() => {
    setModelPickerOpen(true);
  }, []);
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [streamingPartId, setStreamingPartId] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const initialSession = useRef<SessionId | null>(null);
  const initializedTailSession = useRef<SessionId | null>(null);
  const streamAnchor = useRef<{ index: number; offset: number } | null>(null);
  const [initialTailReady, setInitialTailReady] = useState(false);
  const [newOutputCount, setNewOutputCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const messages = data?.messages ?? [];
  const timelineByMessage = useMemo(
    () => timelineEventsByTurn(messages, data?.session.agentEvents ?? []),
    [data?.session.agentEvents, messages],
  );
  const getTranscriptScrollElement = useCallback(() => viewport.current, []);
  const estimateTranscriptMessageSize = useCallback(() => 248, []);
  const measureTranscriptMessage = useCallback(
    (element: Element) => element.getBoundingClientRect().height,
    [],
  );
  const streamingMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === 'assistant') return message.id;
    }
    return undefined;
  }, [messages.length, sessionId]);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: getTranscriptScrollElement,
    paddingStart: 40,
    // Keep the estimate callback stable. TanStack uses its identity when it
    // rebuilds measurements; closing over the live message array invalidated
    // all 10k cached row sizes after each transcript update.
    estimateSize: estimateTranscriptMessageSize,
    measureElement: measureTranscriptMessage,
    overscan: 5,
  });
  useEffect(() => {
    const pending = new Map<string, string>();
    let frame = 0;
    const flush = () => {
      frame = 0;
      for (const [partId, text] of pending) {
        setStreamingPartId(partId);
        if (!pinnedToBottom.current) {
          streamAnchor.current ??= captureTranscriptAnchor(viewport.current);
          setNewOutputCount((count) => count + 1);
        }
        publishStreamedText(partId, text);
      }
      pending.clear();
    };
    const off = client.on('session.delta', (event) => {
      if (event.sessionId !== sessionId) return;
      pending.set(event.partId, `${pending.get(event.partId) ?? ''}${event.textDelta}`);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    const partOff = client.on('session.part', (event) => {
      if (event.sessionId !== sessionId) return;
      flush();
      clearStreamedText(event.part.id);
      setStreamingPartId((current) => (current === event.part.id ? null : current));
    });
    return () => {
      off();
      partOff();
      if (frame) cancelAnimationFrame(frame);
      flush();
    };
  }, [client, sessionId]);
  useEffect(() => {
    if (new URLSearchParams(location.search).get('demo') !== 'long' || !initialTailReady) return;
    window.ferryPerfReady = true;
    const frameTimes: number[] = [];
    let previousFrame = performance.now();
    let frameId = 0;
    const sampleFrame = () => {
      const now = performance.now();
      frameTimes.push(now - previousFrame);
      previousFrame = now;
      frameId = requestAnimationFrame(sampleFrame);
    };
    frameId = requestAnimationFrame(sampleFrame);
    const speedParam = Number(new URLSearchParams(location.search).get('speed'));
    const streamSpeed = Number.isFinite(speedParam) && speedParam > 0 ? speedParam : 1;
    let stream = 0;
    const emit = () => {
      if (document.visibilityState === 'visible' && !window.ferryHost?.isWindowBackgrounded()) {
        if (!pinnedToBottom.current) {
          streamAnchor.current ??= captureTranscriptAnchor(viewport.current);
          setNewOutputCount((count) => count + 1);
        }
        setStreamingPartId('perf-demo-stream');
        publishStreamedText('perf-demo-stream', ' token ');
      }
      stream = window.setTimeout(emit, 80 * streamSpeed);
    };
    stream = window.setTimeout(emit, 80 * streamSpeed);
    const finish = window.setTimeout(() => {
      window.clearTimeout(stream);
      cancelAnimationFrame(frameId);
      window.ferryPerfFrameTimes = frameTimes;
    }, 4_000);
    return () => {
      window.ferryPerfReady = false;
      window.clearTimeout(stream);
      window.clearTimeout(finish);
      cancelAnimationFrame(frameId);
    };
  }, [initialTailReady]);
  useLayoutEffect(() => {
    if (!data) return;
    if (initialSession.current !== sessionId) {
      initialSession.current = sessionId;
      initializedTailSession.current = null;
      pinnedToBottom.current = true;
      setAtBottom(true);
      setInitialTailReady(false);
    }
    if (initializedTailSession.current === sessionId) return;
    if (messages.length === 0) {
      setInitialTailReady(true);
      return;
    }
    setInitialTailReady(false);
    const lastIndex = messages.length - 1;
    let cancelled = false;
    let frame = 0;
    let tailLookupAttempts = 0;
    const scrollTail = () => {
      virtualizer.measure();
      virtualizer.scrollToIndex(lastIndex, { align: 'end' });
      frame = requestAnimationFrame(() => {
        const last = viewport.current?.querySelector<HTMLElement>(
          `.transcript-message[data-index="${String(lastIndex)}"]`,
        );
        if (last) virtualizer.measureElement(last);
        frame = requestAnimationFrame(() => {
          const element = viewport.current;
          const tail = element?.querySelector<HTMLElement>(
            `.transcript-message[data-index="${String(lastIndex)}"]`,
          );
          if (!element || !tail) {
            tailLookupAttempts += 1;
            if (!cancelled && tailLookupAttempts < 120) frame = requestAnimationFrame(scrollTail);
            else if (!cancelled) {
              initializedTailSession.current = sessionId;
              pinnedToBottom.current = false;
              setAtBottom(false);
              setInitialTailReady(true);
            }
            return;
          }
          initializedTailSession.current = sessionId;
          setInitialTailReady(true);
          let attempts = 0;
          let stableFrames = 0;
          const alignMeasuredTail = () => {
            if (cancelled) return;
            const tailDelta =
              tail.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
            if (Math.abs(tailDelta) <= 2) {
              stableFrames += 1;
              if (stableFrames >= 3) {
                pinnedToBottom.current = true;
                setAtBottom(true);
                return;
              }
            } else {
              stableFrames = 0;
              element.scrollTop += tailDelta;
            }
            attempts += 1;
            if (attempts < 120) frame = requestAnimationFrame(alignMeasuredTail);
          };
          alignMeasuredTail();
        });
      });
    };
    scrollTail();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [data, initialTailReady, messages.length, sessionId, virtualizer]);
  useLayoutEffect(() => {
    if (!initialTailReady) return;
    const anchor = streamAnchor.current;
    if (!anchor || pinnedToBottom.current) return;
    const element = viewport.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const message = element.querySelector<HTMLElement>(
          `.transcript-message[data-index="${String(anchor.index)}"]`,
        );
        if (!message || pinnedToBottom.current) return;
        const offset = message.getBoundingClientRect().top - element.getBoundingClientRect().top;
        element.scrollTop += offset - anchor.offset;
        streamAnchor.current = null;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [initialTailReady, streamingPartId]);
  useLayoutEffect(() => {
    if (!initialTailReady || !pinnedToBottom.current || messages.length === 0) return;
    const tailIndex = messages.length - 1;
    virtualizer.scrollToIndex(tailIndex, { align: 'end' });
    const frame = requestAnimationFrame(() => {
      const element = viewport.current;
      const tail = element?.querySelector<HTMLElement>(
        `.transcript-message[data-index="${String(tailIndex)}"]`,
      );
      if (!element || !tail) return;
      virtualizer.measureElement(tail);
      const tailDelta =
        tail.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
      if (Math.abs(tailDelta) > 2) element.scrollTop += tailDelta;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [initialTailReady, messages.length, virtualizer]);
  useEffect(() => {
    if (data?.session.title) useUI.getState().renameTab(sessionId, data.session.title);
  }, [data?.session.title, sessionId]);
  useEffect(() => {
    const offUpdated = client.on('session.updated', (session) => {
      if (session.id === sessionId)
        warnOAuthUseOnce(`app:${sessionId}`, session.modelRef, pushToast);
    });
    const offStatus = client.on('session.status', (session) => {
      if (session.id === sessionId)
        warnOAuthUseOnce(`app:${sessionId}`, session.modelRef, pushToast);
      if (session.id === sessionId)
        warnTrainingUseOnce(sessionId, session.modelRef, models, providers, pushToast);
    });
    return () => {
      offUpdated();
      offStatus();
    };
  }, [client, models, providers, pushToast, sessionId]);
  const running =
    data?.session.status === 'running' || data?.session.status === 'awaiting_approval';
  const currentModel = shortModel(data?.session.modelRef, models);
  const workspace = workspaces.find((item) => item.id === data?.session.workspaceId);
  const activateProfile = async (profileId: (typeof profiles)[number]['id']) => {
    await client.profiles.activate(profileId, sessionId);
    await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
    await cache.invalidateQueries({ queryKey: keys.profiles });
  };
  const jumpToLatest = () => {
    const tailIndex = messages.length - 1;
    if (tailIndex < 0) return;
    pinnedToBottom.current = true;
    virtualizer.scrollToIndex(tailIndex, { align: 'end' });
    requestAnimationFrame(() => {
      const tail = viewport.current?.querySelector<HTMLElement>(
        `.transcript-message[data-index="${String(tailIndex)}"]`,
      );
      if (tail) virtualizer.measureElement(tail);
      virtualizer.scrollToIndex(tailIndex, { align: 'end' });
      requestAnimationFrame(() => {
        const element = viewport.current;
        const last = element?.querySelector<HTMLElement>(
          `.transcript-message[data-index="${String(tailIndex)}"]`,
        );
        if (!element || !last) {
          pinnedToBottom.current = false;
          return;
        }
        const tailDelta =
          last.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
        if (Math.abs(tailDelta) > 2) {
          element.scrollTop += tailDelta;
          requestAnimationFrame(() => {
            const finalDelta =
              last.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
            if (Math.abs(finalDelta) <= 2) {
              pinnedToBottom.current = true;
              setNewOutputCount(0);
              setAtBottom(true);
            } else pinnedToBottom.current = false;
          });
          return;
        }
        pinnedToBottom.current = true;
        setNewOutputCount(0);
        setAtBottom(true);
      });
    });
  };
  const resumeInterrupted = async () => {
    if (data?.session.status !== 'interrupted') return;
    try {
      await client.sessions.resume(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to resume this session.';
      if (!message.includes('Confirm before retrying this tool')) {
        pushToast({ kind: 'error', title: 'Resume failed', body: message });
        return;
      }
      if (
        !window.confirm(
          message +
            '\n\nRetry this interrupted tool? It may have completed before the core stopped.',
        )
      )
        return;
      try {
        await client.sessions.resume(sessionId, { retryInterruptedTool: true });
      } catch (retryError) {
        pushToast({
          kind: 'error',
          title: 'Resume failed',
          body: retryError instanceof Error ? retryError.message : message,
        });
        return;
      }
    }
    await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
    await cache.invalidateQueries({ queryKey: keys.sessions });
  };
  const send = async () => {
    const text = prompt.trim();
    if (!text || !data) return;
    if (data.session.title === 'New Chat') {
      const title = text
        .split(/\s+/)
        .slice(0, 6)
        .join(' ')
        .replace(/[.!?…]+$/, '');
      const first = title.at(0);
      const sentenceCase = first ? first.toLocaleUpperCase() + title.slice(1) : 'New Chat';
      useUI.getState().renameTab(sessionId, sentenceCase);
    }
    warnOAuthUseOnce(`app:${sessionId}`, data.session.modelRef, pushToast);
    try {
      await client.sessions.send(sessionId, { text });
      setPrompt('');
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Message could not be sent',
        body: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const planSteps = useMemo(
    () =>
      data?.taskRecord.plan.map((item) => ({
        label: item.text,
        status:
          item.status === 'done'
            ? ('done' as const)
            : item.status === 'doing'
              ? ('active' as const)
              : ('pending' as const),
      })) ?? [],
    [data?.taskRecord.plan],
  );
  if (isError || (!isLoading && !data)) {
    return (
      <section className="canvas session-canvas" data-audit-overflow="intentional">
        <EmptyState
          title="This session is no longer available"
          action="Back to Home"
          onAction={() => void navigate({ to: '/' })}
        />
      </section>
    );
  }
  return (
    <CanvasPanel
      dots={false}
      overflowContained
      header={
        <>
          <div className="session-toolbar-primary flex min-w-0 items-center gap-2">
            <ModelPickerPopover
              sessionId={sessionId}
              mode={data?.session.pinnedModelRef ? 'manual' : 'auto'}
              modelName={currentModel}
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
            />
            {workspace && (
              <button
                aria-label={`Open ${workspace.name} in Library`}
                className="repo-context-pill"
                onClick={() => {
                  localStorage.setItem('ferry.libraryWorkspace', workspace.id);
                  void navigate({ to: '/library' });
                }}
                type="button"
              >
                <GitBranch size={13} />
                {workspace.name} · {workspace.gitBranch ?? 'no branch'}
              </button>
            )}
          </div>
          <div className="session-toolbar-actions flex items-center gap-1">
            <CanvasHeaderActions
              moreItems={[
                {
                  label: 'Copy link',
                  onSelect: () => void navigator.clipboard.writeText(window.location.href),
                },
                { separator: true },
                {
                  label: density === 'compact' ? 'Comfortable density' : 'Compact density',
                  onSelect: () => {
                    useUI.getState().setDensity(density === 'compact' ? 'comfortable' : 'compact');
                  },
                },
              ]}
              onLink={() => void navigator.clipboard.writeText(window.location.href)}
              onShare={() => {
                pushToast({ kind: 'info', title: 'Share', body: 'There is nothing to share yet.' });
              }}
            />
          </div>
        </>
      }
      className={`session-canvas ${density === 'compact' ? 'density-compact' : ''}`}
    >
      <div
        className="transcript-viewport"
        data-at-bottom={atBottom}
        data-new-output-count={newOutputCount}
        data-session-status={data?.session.status ?? 'loading'}
        ref={viewport}
        style={{ visibility: initialTailReady ? 'visible' : 'hidden' }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            pinnedToBottom.current = false;
            setAtBottom(false);
            streamAnchor.current = captureTranscriptAnchor(viewport.current);
          }
        }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
            pinnedToBottom.current = false;
            setAtBottom(false);
          }
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const tail = element.querySelector<HTMLElement>(
            `.transcript-message[data-index="${String(messages.length - 1)}"]`,
          );
          const bottom = Boolean(
            tail &&
            Math.abs(
              tail.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom,
            ) <= 2,
          );
          if (bottom) {
            pinnedToBottom.current = true;
            setNewOutputCount(0);
            setAtBottom(true);
          } else if (!pinnedToBottom.current) {
            streamAnchor.current = captureTranscriptAnchor(element);
            setAtBottom(false);
          }
        }}
      >
        {messages.length === 0 && (
          <div className="session-empty">{data?.session.title ?? 'Loading session…'}</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const message = messages[item.index];
            if (!message) return null;
            const streamPartId = message.id === streamingMessageId ? streamingPartId : null;
            return (
              <TranscriptMessageRow
                key={message.id}
                message={message}
                index={item.index}
                top={item.start}
                modelName={shortModel(message.modelRef, models)}
                planSteps={planSteps}
                timelineEvents={timelineByMessage.get(item.index) ?? []}
                sessionId={sessionId}
                canRetry={data?.session.status === 'error'}
                streamPartId={streamPartId}
                onFullOutput={setFullOutput}
                onPickModel={openModelPicker}
                measureElement={virtualizer.measureElement}
              />
            );
          })}
        </div>
      </div>
      {!atBottom && initialTailReady && (
        <button
          aria-label={`Jump to latest${newOutputCount > 0 ? `, ${String(newOutputCount)} new` : ''}`}
          className="jump-latest"
          onClick={jumpToLatest}
        >
          Jump to latest{newOutputCount > 0 ? ` · ${String(newOutputCount)} new` : ''}
        </button>
      )}
      {data?.session.status === 'interrupted' && (
        <div className="session-resume-banner" role="status">
          <span>
            Session stopped before the task finished. Durable steps and tool results are saved.
          </span>
          <button type="button" onClick={() => void resumeInterrupted()}>
            Resume
          </button>
        </div>
      )}
      <Composer
        value={prompt}
        onChange={setPrompt}
        onSend={() => void send()}
        onStop={() => void client.sessions.cancel(sessionId)}
        running={running}
        profileName={
          profiles.find((profile) => profile.id === data?.session.profileId)?.name ??
          'Best Available'
        }
        onProfileClick={() => undefined}
        profileMenuItems={[
          ...profiles
            .filter((profile) => profile.pinned)
            .map((profile) => ({
              label: profile.name,
              onSelect: () => void activateProfile(profile.id),
            })),
          { separator: true },
          {
            label: 'Manage profiles…',
            onSelect: () => {
              useUI.getState().setSettingsSection('Profiles');
              void navigate({ to: '/settings' });
            },
          },
        ]}
        onAttach={() => {
          pushToast({ kind: 'info', title: 'Attachments arrive later', body: null });
        }}
      />
      {fullOutput !== null && data?.session && (
        <FullOutputDialog
          client={client}
          sessionId={data.session.id}
          handle={fullOutput}
          onClose={() => {
            setFullOutput(null);
          }}
        />
      )}
    </CanvasPanel>
  );
}

export function PlaceholderCanvas({ title }: { title: string }) {
  return (
    <CanvasPanel dots={false}>
      <div className="session-empty">
        <h1>{title}</h1>
        <p>{title} is coming later.</p>
      </div>
    </CanvasPanel>
  );
}
