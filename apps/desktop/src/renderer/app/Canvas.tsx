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
  Effort,
  MessagePart,
  ModelRef,
  Provider,
  RunId,
  SessionDetail,
  SessionId,
} from '@ferry/shared';
import {
  ApprovalCard,
  AgentTimeline,
  AssistantMessage,
  CanvasPanel,
  CheckpointMarker,
  Composer,
  DelegationCard,
  EmptyState,
  ErrorPart,
  FerryMark,
  HandoffMarker,
  MarkdownPart,
  ReasoningPart,
  StreamingCursor,
  ToolCallBlock,
  ToolStepGroup,
  dataUseStatus,
  groupParts,
  UserMessage,
} from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { listAllModels } from '@ferry/client';
import { keys, useProfiles, useSessionDetail, useSettings, useWorkspaces } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import { ComposerModelChip } from './SessionPowerControls';
import { EffortChip } from './EffortChip';
import { FullOutputDialog } from './FullOutputDialog';
import { useDisplayName } from './useDisplayName';
import { ConfirmDialog } from './ConfirmDialog';
import { HomeStats } from './HomeStats';
import { WorkspaceMenu } from './WorkspaceMenu';
import { greeting } from './usageSummary';
import { canScroll, isLatestVisible, readTailGeometry } from './transcriptScroll';
import { ensureWorkspaceTrusted, SendCancelledError, sendMessage } from '../data/sendMessage';
import { Check, Copy } from 'lucide-react';

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

function handoffReasonLabel(reason: string): string {
  switch (reason) {
    case 'quota':
      return 'usage limit';
    case 'rate_limit':
      return 'rate limit';
    case 'context':
      return 'context limit';
    case 'capability':
      return 'tool capability';
    case 'manual':
      return 'manual model choice';
    default:
      return 'provider error';
  }
}

export function InterruptedFooter({ reason }: { reason: string }) {
  const rawSummary = reason.split(':', 1)[0]?.replaceAll('_', ' ').trim() ?? '';
  const normalized = rawSummary.toLocaleLowerCase();
  const summary =
    normalized === 'quota' ||
    normalized.startsWith('quota exhausted') ||
    normalized.includes('usage limit')
      ? 'usage limit'
      : normalized.startsWith('rate limit')
        ? 'rate limit'
        : rawSummary;
  return (
    <p className="mt-2 text-meta text-text-3" role="status">
      Stopped: {summary || 'provider error'}
    </p>
  );
}

function shortModel(
  ref: string | null | undefined,
  models: { ref: string; name: string }[],
): string {
  // No model yet (a new chat before its first reply): say nothing rather than naming an arbitrary
  // catalog model, which showed up as "01-ai/yi-large".
  if (!ref) return '';
  const model = models.find((item) => item.ref === ref);
  return model?.name ?? ref.split('/').at(-1) ?? ref;
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
  const selectedWorkspaceId = useUI((state) => state.selectedWorkspaceId);
  const pendingComposerFocus = useUI((state) => state.pendingComposerFocus);
  const consumeComposerFocus = useCallback(() => {
    useUI.getState().consumeComposerFocus();
  }, []);
  const { data: workspaces = [] } = useWorkspaces();
  const { data: profiles = [] } = useProfiles();
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => listAllModels(client),
  });
  const { data: settings } = useSettings();
  const displayName = useDisplayName();
  const [prompt, setPrompt] = useState('');
  const [draftProfileId, setDraftProfileId] = useState<string | null>(null);
  const [draftModelRef, setDraftModelRef] = useState<ModelRef | null>(null);
  const [draftEffort, setDraftEffort] = useState<Effort | null>(null);
  const activeProfile = profiles.find(
    (profile) => profile.id === (draftProfileId ?? settings?.activeProfileId),
  );
  const activeModel = '';
  const draftModel = models.find((model) => model.ref === draftModelRef);
  const selectedWorkspace =
    workspaces.find((item) => item.id === selectedWorkspaceId) ?? workspaces[0];
  useEffect(() => {
    document.querySelector<HTMLTextAreaElement>('[aria-label="Message Ferry"]')?.focus();
  }, []);
  const send = async () => {
    const text = prompt.trim();
    const workspace = selectedWorkspace;
    if (!text || !workspace) return;
    try {
      // Ask about an untrusted folder before creating the chat, so declining leaves nothing behind.
      if (!(await ensureWorkspaceTrusted(client, workspace))) return;
      const profileId = activeProfile?.id;
      const session = await client.sessions.create({
        workspaceId: workspace.id,
        ...(profileId ? { profileId } : {}),
      });
      if (draftModelRef) await client.models.select(session.id, draftModelRef);
      if (draftEffort && draftModel?.reasoningEfforts?.includes(draftEffort))
        await client.sessions.setEffort(session.id, draftEffort);
      openTab({ id: session.id, title: session.title });
      warnOAuthUseOnce(`app:${session.id}`, draftModelRef ?? session.modelRef, pushToast);
      await sendMessage(client, session.id, { text });
      setPrompt('');
      await cache.invalidateQueries({ queryKey: keys.sessions });
      await navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
    } catch (error) {
      if (error instanceof SendCancelledError) return;
      pushToast({
        kind: 'error',
        title: 'Chat could not be started',
        body: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <CanvasPanel className="home-canvas v2-home-canvas">
      <div className="v2-home-layout">
        <div className="v2-home-greeting">
          <FerryMark size={36} variant="brand" />
          <h1>{displayName ? `${greeting()}, ${displayName}.` : `${greeting()}.`}</h1>
        </div>
        <Composer
          value={prompt}
          focusRequested={pendingComposerFocus}
          onFocusRequestConsumed={consumeComposerFocus}
          onChange={setPrompt}
          onSend={() => void send()}
          onStop={() => undefined}
          running={false}
          profileName={activeProfile?.name ?? 'Auto profile'}
          profileControl={
            <ComposerModelChip
              sessionId={null}
              profileName={activeProfile?.name ?? 'Auto profile'}
              {...(activeProfile ? { activeProfileId: activeProfile.id } : {})}
              profiles={profiles}
              mode={draftModelRef ? 'manual' : 'auto'}
              modelName={draftModel?.name ?? activeModel}
              modelRef={draftModelRef}
              onProfileSelect={setDraftProfileId}
              onModelSelect={(ref) => {
                setDraftModelRef(ref === 'auto' ? null : ref);
              }}
            />
          }
          effortControl={
            <EffortChip
              efforts={draftModel?.reasoningEfforts}
              value={draftEffort}
              onChange={setDraftEffort}
            />
          }
          workspaceControl={
            <WorkspaceMenu selectedId={selectedWorkspace?.id} workspaces={workspaces} />
          }
        />
        <HomeStats />
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
      await sendMessage(client, sessionId, { text, ...(routingMode ? { routingMode } : {}) });
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
          reason={handoffReasonLabel(part.reason)}
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
            onRaiseCap={
              paidCapReached
                ? () => {
                    useUI.getState().openSettings('Routing');
                  }
                : undefined
            }
            onStop={paidCapReached ? () => void client.sessions.cancel(sessionId) : undefined}
            onAddProvider={
              !paidCapReached && presentation.allExhausted
                ? () => void navigate({ to: '/models' })
                : undefined
            }
          />
          {presentation.summary.startsWith('No available model —') ? (
            <button
              className="rounded-md bg-primary px-3 py-1.5 text-label font-medium text-primary-foreground"
              onClick={() => void navigate({ to: '/models' })}
              type="button"
            >
              View providers
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
  contextWindow,
  requestedModelName,
  planSteps,
  timelineEvents,
  sessionId,
  canRetry,
  streamPartId,
  isRunning,
  onFullOutput,
  onPickModel,
  measureElement,
}: {
  message: SessionDetail['messages'][number];
  index: number;
  top: number;
  modelName: string;
  contextWindow: number | undefined;
  /** Display name of the model the user asked for, when it differs from the one that answered. */
  requestedModelName?: string;
  planSteps: { label: string; status: 'done' | 'active' | 'pending' }[];
  timelineEvents: AgentEvent[];
  sessionId: SessionId;
  canRetry: boolean;
  streamPartId: string | null;
  isRunning: boolean;
  onFullOutput: (handle: string) => void;
  onPickModel: () => void;
  measureElement: (element: HTMLElement | null) => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const setRightTab = useUI((state) => state.setRightTab);
  const openReview = (runId: RunId) => {
    void navigate({
      to: '/s/$sessionId/review/$runId',
      params: { sessionId, runId },
    });
  };
  const streamingText = useStreamedText(streamPartId);
  const streamingPartIsInMessage =
    streamPartId !== null && message.parts.some((part) => part.id === streamPartId);
  const timelineHasThinking = timelineEvents.some((event) => event.type === 'thinking');
  const answerText = timelineEvents
    .flatMap((event) => (event.type === 'text' ? [event.content] : []))
    .join('');
  const hasMessageAnswer = message.parts.some((part) => part.type === 'text');
  const messageText =
    message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') || answerText;
  const [copied, setCopied] = useState(false);
  const copyMessage = () =>
    void navigator.clipboard.writeText(messageText).then(() => {
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1500);
    });
  const retryMessage = async () => {
    try {
      const detail = await client.sessions.get(sessionId);
      const lastUserMessage = detail.messages.filter((item) => item.role === 'user').at(-1);
      const text = lastUserMessage?.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      if (!text) return;
      await sendMessage(client, sessionId, { text });
      await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
    } catch (error) {
      if (error instanceof SendCancelledError) return;
      useToasts.getState().push({
        kind: 'error',
        title: 'Retry failed',
        body: error instanceof Error ? error.message : String(error),
      });
    }
  };
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
        <div className="message-answer">
          <UserMessage>
            {message.parts
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('')}
          </UserMessage>
        </div>
      ) : (
        <AssistantMessage {...(message.agentRole ? { agentRole: message.agentRole } : {})}>
          <AgentTimeline
            events={timelineEvents}
            modelName={modelName}
            contextWindow={contextWindow}
            startedAt={message.createdAt}
            isRunning={isRunning}
            runningToolTitle={message.parts.reduce<string | null>(
              (title, part) =>
                part.type === 'tool_call' && part.status === 'running' ? part.title : title,
              null,
            )}
            currentStep={planSteps.find((step) => step.status === 'active')?.label ?? null}
            activity={groupParts(message.parts).flatMap((part) => {
              if (
                part.type === 'text' ||
                (part.type === 'approval_request' && part.state === 'pending') ||
                part.type === 'delegation' ||
                part.type === 'checkpoint' ||
                part.type === 'tool_group' ||
                part.type === 'tool_call' ||
                part.type === 'error'
              )
                return [];
              if (timelineHasThinking && part.type === 'reasoning') return [];
              if (part.type === 'handoff_marker') {
                const from = shortModel(part.from, []);
                const to = shortModel(part.to, []);
                return [
                  <HandoffMarker
                    key={part.id}
                    from={from}
                    to={to}
                    fromRef={part.from}
                    toRef={part.to}
                    reason={handoffReasonLabel(part.reason)}
                    briefingTokens={part.briefingTokens}
                    explanation={part.explanation}
                  />,
                ];
              }
              if (part.type === 'approval_request') {
                const label = `${part.state === 'denied' ? 'Denied' : 'Allowed'}: ${part.detail}`;
                return [
                  <p className="text-meta text-text-3" key={part.id}>
                    {label}
                  </p>,
                ];
              }

              return [
                <ReasoningPart
                  key={part.id}
                  text={part.text}
                  steps={planSteps}
                  running={isRunning}
                  startedAt={message.createdAt}
                />,
              ];
            })}
            {...(timelineEvents.length
              ? {
                  onShowFull: (handle: string) => {
                    onFullOutput(handle);
                  },
                }
              : {})}
          />
          {groupParts(message.parts).flatMap((part) => {
            if (
              (part.type !== 'approval_request' || part.state !== 'pending') &&
              part.type !== 'delegation' &&
              part.type !== 'checkpoint' &&
              part.type !== 'tool_call' &&
              part.type !== 'error' &&
              part.type !== 'tool_group'
            )
              return [];
            if (part.type === 'tool_group')
              return [
                <ToolStepGroup
                  key={part.parts[0]?.id ?? 'tool-group'}
                  parts={part.parts}
                  onShowFull={onFullOutput}
                  onOpenDiff={() => {
                    setRightTab('changes');
                  }}
                />,
              ];
            return [
              <div key={part.id}>
                <PartView
                  part={part}
                  sessionId={sessionId}
                  canRetry={canRetry}
                  isStreaming={part.id === streamPartId}
                  onFull={onFullOutput}
                  onDiff={() => {
                    setRightTab('changes');
                  }}
                  onReview={openReview}
                  onCancel={(id) => void client.delegation.cancel(id)}
                  onPickAnother={onPickModel}
                />
              </div>,
            ];
          })}
          {groupParts(message.parts).flatMap((part) => {
            if (part.type !== 'text') return [];
            return [
              <div className="message-answer" key={part.id}>
                <PartView
                  part={part}
                  sessionId={sessionId}
                  canRetry={canRetry}
                  isStreaming={part.id === streamPartId}
                  onFull={onFullOutput}
                  onDiff={() => {
                    setRightTab('changes');
                  }}
                  onReview={openReview}
                  onCancel={(id) => void client.delegation.cancel(id)}
                  onPickAnother={onPickModel}
                />
              </div>,
            ];
          })}
          {!hasMessageAnswer && streamingText === null && answerText && (
            <div className="message-answer">
              <MarkdownPart content={answerText} />
            </div>
          )}
          {streamingText !== null && !streamingPartIsInMessage && (
            <div className="message-answer whitespace-pre-wrap break-words">
              {streamingText}
              <StreamingCursor />
            </div>
          )}
          {streamingText !== null && streamingPartIsInMessage && <StreamingCursor />}
          {message.via?.kind === 'gateway' ? (
            <p className="mt-2 text-meta text-text-3">
              via Gateway key {message.via.keyName}
              {modelName ? ` · served ${modelName}` : ''}
            </p>
          ) : message.requestedModelRef && message.requestedModelRef !== message.modelRef ? (
            <p className="mt-2 text-meta text-text-3">
              Requested {requestedModelName ?? 'Auto'} · served {modelName}
            </p>
          ) : null}
          {message.interrupted ? <InterruptedFooter reason={message.interrupted.reason} /> : null}
        </AssistantMessage>
      )}
      <div className={`v2-message-actions${message.role === 'user' ? ' is-user' : ''}`}>
        <button
          aria-label={copied ? 'Copied' : 'Copy message'}
          className="v2-message-copy"
          onClick={copyMessage}
          title={copied ? 'Copied' : 'Copy'}
          type="button"
        >
          {copied ? (
            <Check aria-hidden="true" size={14} strokeWidth={1.75} />
          ) : (
            <Copy aria-hidden="true" size={14} strokeWidth={1.75} />
          )}
        </button>
        {message.role === 'assistant' && canRetry && (
          <button aria-label="Retry response" onClick={() => void retryMessage()} type="button">
            Retry
          </button>
        )}
      </div>
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
  const consumeComposerFocus = useCallback(() => {
    useUI.getState().consumeComposerFocus();
  }, []);
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const openModelPicker = useCallback(() => {
    setModelPickerOpen(true);
  }, []);
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [retryInterruptedPrompt, setRetryInterruptedPrompt] = useState<string | null>(null);
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
  const pendingApprovalIndex = useMemo(
    () =>
      messages.findIndex((message) =>
        message.parts.some((part) => part.type === 'approval_request' && part.state === 'pending'),
      ),
    [messages],
  );
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
            // A short transcript cannot scroll its tail down to the bottom edge; that is settled too.
            if (Math.abs(tailDelta) <= 2 || (tailDelta < 0 && element.scrollTop <= 0)) {
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
  useLayoutEffect(() => {
    if (!initialTailReady || pendingApprovalIndex < 0) return;
    pinnedToBottom.current = true;
    setAtBottom(true);
    virtualizer.scrollToIndex(pendingApprovalIndex, { align: 'end' });
    const frame = requestAnimationFrame(() => {
      const element = viewport.current;
      const approvalMessage = element?.querySelector<HTMLElement>(
        `.transcript-message[data-index="${String(pendingApprovalIndex)}"]`,
      );
      if (!element || !approvalMessage) return;
      virtualizer.measureElement(approvalMessage);
      const delta =
        approvalMessage.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
      if (Math.abs(delta) > 2) element.scrollTop += delta;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [initialTailReady, pendingApprovalIndex, virtualizer]);
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
  const pinnedUnavailable = Boolean(
    data?.session.pinnedModelRef &&
    data.session.modelRef &&
    data.session.pinnedModelRef !== data.session.modelRef &&
    messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === 'handoff_marker' &&
          part.from === data.session.pinnedModelRef &&
          part.to === data.session.modelRef &&
          part.reason !== 'manual',
      ),
    ),
  );
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
            if (isLatestVisible(readTailGeometry(element, last))) {
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
      setRetryInterruptedPrompt(message);
      return;
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
      await sendMessage(client, sessionId, { text });
      setPrompt('');
    } catch (error) {
      if (error instanceof SendCancelledError) return;
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
  const renderComposer = () => (
    <Composer
      value={prompt}
      focusRequested={pendingComposerFocus}
      onFocusRequestConsumed={consumeComposerFocus}
      onChange={setPrompt}
      onSend={() => void send()}
      onStop={() => void client.sessions.cancel(sessionId)}
      running={running}
      banner={
        data?.session.status === 'running'
          ? {
              text:
                data.session.runPhase === 'preparing'
                  ? 'Preparing… Ferry is getting this chat ready.'
                  : 'Working… replies and tool steps appear above as they happen.',
              actionLabel: 'Stop',
              onAction: () => void client.sessions.cancel(sessionId),
            }
          : null
      }
      profileName={
        profiles.find((profile) => profile.id === data?.session.profileId)?.name ?? 'Best Available'
      }
      profileControl={
        <ComposerModelChip
          sessionId={sessionId}
          profileName={
            profiles.find((profile) => profile.id === data?.session.profileId)?.name ??
            'Best Available'
          }
          mode={data?.session.pinnedModelRef ? 'manual' : 'auto'}
          modelName={currentModel}
          modelRef={data?.session.pinnedModelRef ?? null}
          servedModelRef={data?.session.modelRef ?? null}
          pinnedUnavailable={pinnedUnavailable}
          open={modelPickerOpen}
          onOpenChange={setModelPickerOpen}
          profiles={profiles}
          {...(data?.session.profileId ? { activeProfileId: data.session.profileId } : {})}
          onProfileSelect={(profileId) => {
            void activateProfile(profileId);
          }}
        />
      }
      effortControl={
        <EffortChip
          efforts={
            models.find((model) => model.ref === data?.session.pinnedModelRef)?.reasoningEfforts
          }
          value={data?.session.effort}
          onChange={(effort) => {
            void client.sessions
              .setEffort(sessionId, effort)
              .then((session) => {
                const key = keys.session(sessionId);
                const current = cache.getQueryData<SessionDetail>(key);
                if (current) cache.setQueryData(key, { ...current, session });
              })
              .catch((error: unknown) => {
                pushToast({
                  kind: 'error',
                  title: 'Effort could not be changed',
                  body: error instanceof Error ? error.message : String(error),
                });
              });
          }}
        />
      }
      workspaceControl={
        <WorkspaceMenu lockedToSession selectedId={workspace?.id} workspaces={workspaces} />
      }
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
            useUI.getState().openSettings('Profiles');
          },
        },
      ]}
    />
  );
  return (
    <>
      <CanvasPanel
        overflowContained
        className={`session-canvas v2-session-canvas ${density === 'compact' ? 'density-compact' : ''}`}
      >
        <div
          className={`transcript-viewport ${messages.length === 0 ? 'is-empty' : ''}`}
          data-at-bottom={atBottom}
          data-new-output-count={newOutputCount}
          data-session-status={data?.session.status ?? 'loading'}
          ref={viewport}
          style={{ visibility: initialTailReady ? 'visible' : 'hidden' }}
          onWheel={(event) => {
            // Unpin only; the scroll handler decides whether the latest message left the view.
            if (event.deltaY < 0 && canScroll(event.currentTarget)) {
              pinnedToBottom.current = false;
              streamAnchor.current = captureTranscriptAnchor(viewport.current);
            }
          }}
          onKeyDown={(event) => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && canScroll(event.currentTarget))
              pinnedToBottom.current = false;
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            const tail = element.querySelector<HTMLElement>(
              `.transcript-message[data-index="${String(messages.length - 1)}"]`,
            );
            const bottom =
              messages.length === 0 || isLatestVisible(readTailGeometry(element, tail));
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
            <div className="session-empty">
              <div className="session-empty-greeting">
                <FerryMark size={32} variant="brand" />
                <span>What would you like to work on?</span>
              </div>
              {renderComposer()}
            </div>
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
                  contextWindow={
                    models.find((model) => model.ref === message.modelRef)?.contextWindow
                  }
                  {...(message.requestedModelRef && message.requestedModelRef !== 'auto'
                    ? { requestedModelName: shortModel(message.requestedModelRef, models) }
                    : {})}
                  planSteps={planSteps}
                  timelineEvents={timelineByMessage.get(item.index) ?? []}
                  sessionId={sessionId}
                  canRetry={data?.session.status === 'error'}
                  streamPartId={streamPartId}
                  isRunning={running && message.id === streamingMessageId}
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
        {messages.length > 0 && renderComposer()}
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
      <ConfirmDialog
        open={retryInterruptedPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setRetryInterruptedPrompt(null);
        }}
        title="Retry interrupted tool?"
        description="It may have completed before Ferry stopped."
        confirmLabel="Retry tool"
        onConfirm={() => {
          setRetryInterruptedPrompt(null);
          void client.sessions
            .resume(sessionId, { retryInterruptedTool: true })
            .then(async () => {
              await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
              await cache.invalidateQueries({ queryKey: keys.sessions });
            })
            .catch((error: unknown) => {
              pushToast({
                kind: 'error',
                title: 'Resume failed',
                body: error instanceof Error ? error.message : 'Unable to resume this session.',
              });
            });
        }}
      />
    </>
  );
}

export function PlaceholderCanvas({ title }: { title: string }) {
  return (
    <CanvasPanel>
      <div className="session-empty">
        <h1>{title}</h1>
        <p>{title} is coming later.</p>
      </div>
    </CanvasPanel>
  );
}
