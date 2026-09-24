import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MessagePart, RunId, SessionDetail, SessionId } from '@ferry/shared';
import {
  ApprovalCard,
  AssistantMessage,
  CanvasHeaderActions,
  CanvasPanel,
  CheckpointMarker,
  Composer,
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
  groupParts,
  UserMessage,
  DropdownMenu,
} from '@ferry/ui';
import { GitBranch, MoreHorizontal } from 'lucide-react';
import { useFerryClient } from '../data/client';
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

const starters: Record<string, string> = {
  'Explain this repo': 'Explain how this repository is structured and where the main flows live.',
  'Fix failing tests': 'Find and fix the failing tests in this repo.',
  'Write tests': 'Add focused tests for the behavior that is currently missing.',
  Refactor: 'Refactor the selected code while preserving its current behavior.',
  'Review my changes': 'Review my current changes for bugs and missing tests.',
  'Plan a feature': 'Help me plan this feature and identify the files it will touch.',
};

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
    queryFn: () => client.models.list(),
  });
  const { data: candidates = [] } = useQuery({
    queryKey: ['model-candidates', null],
    queryFn: () => client.models.candidates(null),
  });
  const [prompt, setPrompt] = useState('');
  const activeProfile = profiles.find((profile) => profile.id === settings?.activeProfileId);
  const pinned = sessions.filter((session) => session.pinned).slice(0, 5);
  const send = async () => {
    const text = prompt.trim();
    const workspace = workspaces[0];
    if (!text || !workspace) return;
    const session = await client.sessions.create({
      workspaceId: workspace.id,
      ...(settings?.activeProfileId ? { profileId: settings.activeProfileId } : {}),
    });
    openTab({ id: session.id, title: session.title });
    await client.sessions.send(session.id, { text });
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
      <div className="home-content">
        <Hero
          title={['Build bigger with Ferry,', 'every free model, one seamless task.']}
          subtitle="Ferry routes each step to the model that still has room, and carries your task across when one runs dry."
        />
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
        <SuggestionChips
          onSelect={(label) => {
            setPrompt(starters[label] ?? label);
          }}
        />
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
                      to: capacity.banner?.action === 'open_usage' ? '/explore/usage' : '/explore',
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
        <Disclaimer />
      </div>
    </CanvasPanel>
  );
}

function PartView({
  part,
  sessionId,
  onFull,
  onDiff,
  onReview,
  onCancel,
}: {
  part: MessagePart;
  sessionId: SessionId;
  onFull: (text: string) => void;
  onDiff: () => void;
  onReview: (id: RunId) => void;
  onCancel: (id: RunId) => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  switch (part.type) {
    case 'text':
      return <MarkdownPart content={part.text} />;
    case 'reasoning':
      return <ReasoningPart text={part.text} />;
    case 'tool_call':
      return (
        <ToolCallBlock
          {...part}
          onShowFull={() => {
            onFull(`${part.output?.text ?? ''}\n\nFull output restored from recovery handle.`);
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
    case 'error':
      return <ErrorPart message={part.message} />;
  }
}

function DelegationRunView({
  sessionId,
  runId,
  onReview,
  onCancel,
}: {
  sessionId: SessionId;
  runId: string;
  onReview: (id: RunId) => void;
  onCancel: (id: RunId) => void;
}) {
  const client = useFerryClient();
  const { data: runs = [] } = useQuery({
    queryKey: ['delegation', sessionId],
    queryFn: () => client.delegation.runs(sessionId),
    refetchInterval: 1000,
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
      onReviewDiff={() => {
        onReview(run.id);
      }}
      onCancel={() => {
        onCancel(run.id);
      }}
    />
  );
}

export function SessionCanvas() {
  const { sessionId: rawId } = useParams({ from: '/s/$sessionId' });
  const sessionId = rawId as SessionId;
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const pushToast = useToasts((state) => state.push);
  const setRightTab = useUI((state) => state.setRightTab);
  const density = useUI((state) => state.density);
  const { data } = useSessionDetail(sessionId);
  const { data: workspaces = [] } = useWorkspaces();
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => client.models.list(),
  });
  const { data: profiles = [] } = useProfiles();
  const [prompt, setPrompt] = useState('');
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const messages = data?.messages ?? [];
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => (messages[index]?.parts.length ?? 0) * 76 + 96,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 5,
  });
  useEffect(() => {
    const off = client.on('session.delta', (event) => {
      if (event.sessionId !== sessionId) return;
      setStreaming((current) => ({
        ...current,
        [event.partId]: `${current[event.partId] ?? ''}${event.textDelta}`,
      }));
    });
    const partOff = client.on('session.part', (event) => {
      if (event.sessionId !== sessionId) return;
      setStreaming((current) => {
        if (!(event.part.id in current)) return current;
        return Object.fromEntries(
          Object.entries(current).filter(([partId]) => partId !== event.part.id),
        );
      });
    });
    return () => {
      off();
      partOff();
    };
  }, [client, sessionId]);
  useEffect(() => {
    if (atBottom) virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
  }, [atBottom, messages.length, streaming, virtualizer]);
  useEffect(() => {
    if (data?.session.title) useUI.getState().renameTab(sessionId, data.session.title);
  }, [data?.session.title, sessionId]);
  const running =
    data?.session.status === 'running' || data?.session.status === 'awaiting_approval';
  const currentModel = shortModel(data?.session.modelRef, models);
  const workspace = workspaces.find((item) => item.id === data?.session.workspaceId);
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
    await client.sessions.send(sessionId, { text });
    setPrompt('');
    await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
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
  return (
    <CanvasPanel
      dots={false}
      header={
        <>
          <div className="flex min-w-0 items-center gap-2">
            <ModelPickerPopover
              sessionId={sessionId}
              mode={data?.session.modelRef ? 'manual' : 'auto'}
              modelName={currentModel}
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
          <div className="flex items-center gap-1">
            <DropdownMenu
              trigger={
                <button
                  aria-label="Session options"
                  className="inline-flex size-8 items-center justify-center rounded-full text-text-2 hover:bg-white/[0.05]"
                  type="button"
                >
                  <MoreHorizontal size={17} />
                </button>
              }
              items={[
                {
                  label: density === 'compact' ? 'Comfortable density' : 'Compact density',
                  onSelect: () => {
                    useUI.getState().setDensity(density === 'compact' ? 'comfortable' : 'compact');
                  },
                },
              ]}
            />
            <CanvasHeaderActions
              onLink={() => {
                void navigator.clipboard.writeText(window.location.href);
              }}
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
        ref={viewport}
        onScroll={(event) => {
          const element = event.currentTarget;
          const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          setAtBottom(bottom);
        }}
      >
        {messages.length === 0 && (
          <div className="session-empty">{data?.session.title ?? 'Loading session…'}</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const message = messages[item.index];
            if (!message) return null;
            return (
              <div
                className="transcript-message"
                data-index={item.index}
                key={message.id}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  width: 'min(760px, 100%)',
                  transform: `translate(-50%, ${String(item.start)}px)`,
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
                  <AssistantMessage modelName={shortModel(message.modelRef, models)}>
                    {groupParts(message.parts).map((part) =>
                      part.type === 'tool_group' ? (
                        <ToolStepGroup
                          key={part.parts[0]?.id ?? 'tool-group'}
                          parts={part.parts}
                          onShowFull={setFullOutput}
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
                          onFull={setFullOutput}
                          onDiff={() => {
                            setRightTab('changes');
                          }}
                          onReview={(runId) => {
                            void navigate({
                              to: '/s/$sessionId/review/$runId',
                              params: { sessionId, runId },
                            });
                          }}
                          onCancel={(id) => void client.delegation.cancel(id)}
                        />
                      ),
                    )}
                    {Object.entries(streaming)
                      .filter(([id]) => !message.parts.some((part) => part.id === id))
                      .map(([id, text]) => (
                        <div key={id}>
                          <MarkdownPart content={text} />
                          <StreamingCursor />
                        </div>
                      ))}
                  </AssistantMessage>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!atBottom && (
        <button
          className="jump-latest"
          onClick={() => {
            setAtBottom(true);
            virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
          }}
        >
          Jump to latest
        </button>
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
        onProfileClick={() => {
          pushToast({
            kind: 'info',
            title: 'Session profile',
            body: 'Change this session profile from its tab menu.',
          });
        }}
        onAttach={() => {
          pushToast({ kind: 'info', title: 'Attachments arrive later', body: null });
        }}
      />
      {fullOutput !== null && (
        <div
          role="presentation"
          className="output-dialog-backdrop"
          onClick={() => {
            setFullOutput(null);
          }}
        >
          <section
            aria-label="Full tool output"
            aria-modal="true"
            className="output-dialog"
            role="dialog"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <header>
              <strong>Full output</strong>
              <button
                onClick={() => {
                  setFullOutput(null);
                }}
              >
                Close
              </button>
            </header>
            <pre>{fullOutput}</pre>
          </section>
        </div>
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
