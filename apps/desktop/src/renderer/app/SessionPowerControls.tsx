import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Bell, Check, ChevronDown, Search, X } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { DataUseBadge, Dialog, FerryMark, Pill, ShowMoreList, TagBadge } from '@ferry/ui';
import type { ModelRef, PartId, ProfileId, SessionId } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { listAllModels } from '@ferry/client';
import { keys, useSessions, useWorkspaces } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI, type SettingsSection } from '../state/ui';
import { ModelQualityBadge } from './ModelQualityBadge';
import { matchesKeybinding } from '@ferry/config/keybindings';
import { useKeybindings } from '../state/keybindings';
import { scorePaletteMatch } from './paletteSearch';

export function SessionPowerControls({ onNewChat }: { onNewChat: () => Promise<void> }) {
  return <CommandPalette onNewChat={onNewChat} />;
}

function useCmdk(open: boolean) {
  const [CommandModule, setCommandModule] = useState<typeof import('cmdk').Command | null>(null);
  useEffect(() => {
    if (!open || CommandModule) return;
    let current = true;
    void import('cmdk').then(({ Command: LoadedCommand }) => {
      if (current) setCommandModule(() => LoadedCommand);
    });
    return () => {
      current = false;
    };
  }, [open, CommandModule]);
  return CommandModule;
}

export function ApprovalsTray({ activeSessionId }: { activeSessionId?: string | null }) {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { data: sessions = [] } = useSessions();
  const [open, setOpen] = useState(false);
  const details = useQueries({
    queries: sessions.map((session) => ({
      queryKey: keys.session(session.id),
      queryFn: () => client.sessions.get(session.id),
    })),
  });
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
    };
  }, [open]);
  const pending = details.flatMap((query) => {
    const detail = query.data;
    if (!detail) return [];
    return detail.messages.flatMap((message) =>
      message.parts
        .filter((part) => part.type === 'approval_request' && part.state === 'pending')
        .filter(() => detail.session.id !== activeSessionId)
        .map((part) => ({ session: detail.session, part })),
    );
  });
  const respond = async (sessionId: SessionId, partId: string, decision: 'allow_once' | 'deny') => {
    await client.approvals.respond(sessionId, partId as PartId, decision);
    await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
  };
  return pending.length ? (
    <div className="relative v2-approvals-anchor">
      <button
        aria-label={`Approvals${pending.length ? `, ${String(pending.length)} pending` : ''}`}
        className="relative inline-flex size-8 items-center justify-center rounded-full text-text-2 hover:bg-icon-circle"
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <Bell size={17} />
        {pending.length > 0 && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-warn px-1 text-center text-[10px] leading-[14px] text-[var(--bg-app)]">
            {pending.length}
          </span>
        )}
      </button>
      {open && (
        <div aria-label="Pending approvals" className="approval-tray" role="dialog">
          <header>
            <strong>Approvals</strong>
            <button
              aria-label="Close approvals"
              onClick={() => {
                setOpen(false);
              }}
            >
              <X size={14} />
            </button>
          </header>
          {!pending.length && <p className="text-label text-text-3">No pending approvals</p>}
          {pending.map(({ session, part }) =>
            part.type === 'approval_request' ? (
              <article key={`${session.id}-${part.id}`}>
                <strong>{session.title}</strong>
                <p>{part.summary}</p>
                <small>{part.risk} risk</small>
                <div>
                  <Pill
                    size="sm"
                    variant="blue-tint"
                    onClick={() => {
                      void respond(session.id, part.id, 'allow_once');
                    }}
                  >
                    Allow once
                  </Pill>
                  <Pill
                    size="sm"
                    variant="warm-outline"
                    onClick={() => {
                      void respond(session.id, part.id, 'deny');
                    }}
                  >
                    Deny
                  </Pill>
                  <button
                    className="text-link text-meta"
                    onClick={() => {
                      void navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
                      setOpen(false);
                    }}
                  >
                    Open session
                  </button>
                </div>
              </article>
            ) : null,
          )}
        </div>
      )}
    </div>
  ) : null;
}

export function CommandPalette({ onNewChat }: { onNewChat: () => Promise<void> }) {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const { data: sessions = [] } = useSessions();
  const { data: workspaces = [] } = useWorkspaces();
  const activeId = useUI((state) => state.activeId);
  const density = useUI((state) => state.density);
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const actionAfterClose = useRef<(() => void | Promise<void>) | null>(null);
  const { bindings } = useKeybindings();
  const PaletteCommand = useCmdk(open);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      const editableFocus =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      const terminalFocus =
        target instanceof HTMLElement && Boolean(target.closest('.xterm, [data-terminal-focus]'));
      const binding = bindings.find((item) => item.command === 'palette.open');
      if (
        binding &&
        matchesKeybinding(binding, event, {
          editableFocus,
          terminalFocus,
          paletteOpen: open,
          isDesktop: Boolean(window.ferryHost),
        })
      ) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', handler);
    const openPalette = () => {
      setOpen(true);
    };
    window.addEventListener('ferry:open-command-palette', openPalette);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('ferry:open-command-palette', openPalette);
    };
  }, [bindings, open]);
  const runAction = async (action: string) => {
    if (action.startsWith('settings:')) {
      useUI.getState().setSettingsSection(action.slice('settings:'.length) as SettingsSection);
      await navigate({ to: '/settings' });
      return;
    }
    if (action.startsWith('explore:')) {
      useUI
        .getState()
        .setExploreFilter(
          action.slice('explore:'.length) as 'All' | 'Free' | 'Needs attention' | 'Configured',
        );
      await navigate({ to: '/models' });
      return;
    }
    switch (action) {
      case 'new': {
        await onNewChat();
        break;
      }
      case 'folder': {
        const path = await window.ferryHost?.openFolder();
        if (path) {
          await client.workspaces.open(path);
          await cache.invalidateQueries({ queryKey: keys.workspaces });
        } else
          pushToast({
            kind: 'info',
            title: 'Open folder',
            body: 'Folder selection is available in the desktop app.',
          });
        break;
      }
      case 'density':
        useUI.getState().setDensity(density === 'compact' ? 'comfortable' : 'compact');
        break;
      case 'sidebar':
        useUI.getState().toggleLeft();
        break;
      case 'panel':
        useUI.getState().toggleRight();
        break;
      case 'terminal':
        useUI.getState().toggleBottom();
        break;
      case 'theme': {
        const settings = await client.settings.get();
        const theme = settings.theme === 'dark' ? 'light' : 'dark';
        await client.settings.update({ theme });
        await cache.invalidateQueries({ queryKey: keys.settings });
        break;
      }
      case 'model':
        if (activeId)
          window.dispatchEvent(
            new CustomEvent('ferry:open-model-picker', { detail: { sessionId: activeId } }),
          );
        break;
      case 'explore':
        await navigate({ to: '/models' });
        break;
      case 'usage':
        await navigate({ to: '/models/usage' });
        break;
      case 'library':
        await navigate({ to: '/library' });
        break;
      case 'settings':
        await navigate({ to: '/settings' });
        break;
      case 'shortcuts':
        window.dispatchEvent(new Event('ferry:show-shortcuts'));
        break;
      case 'delegate':
        useUI.getState().setRightTab('plan');
        if (useUI.getState().rightCollapsed) useUI.getState().toggleRight();
        pushToast({
          kind: 'info',
          title: 'Delegate current task',
          body: 'Choose a lane and brief from the Plan panel.',
        });
        break;
      case 'checkpoint': {
        if (!activeId) break;
        const checkpoints = await client.checkpoints.list(activeId);
        const latest = checkpoints.at(-1);
        if (latest) {
          await client.checkpoints.restore(latest.id);
          pushToast({ kind: 'success', title: 'Checkpoint restored', body: latest.label });
        } else pushToast({ kind: 'info', title: 'No checkpoints', body: null });
        break;
      }
      case 'profile': {
        const [profiles, settings] = await Promise.all([
          client.profiles.list(),
          client.settings.get(),
        ]);
        const pinned = profiles.filter((profile) => profile.pinned);
        const index = pinned.findIndex((profile) => profile.id === settings.activeProfileId);
        const next = pinned[(index + 1) % pinned.length];
        if (next) {
          await client.profiles.activate(next.id, activeId ?? undefined);
          await cache.invalidateQueries({ queryKey: keys.profiles });
          await cache.invalidateQueries({ queryKey: keys.settings });
          pushToast({ kind: 'success', title: 'Profile selected', body: next.name });
        }
        break;
      }
    }
  };
  const closeThenRun = (action: () => void | Promise<void>) => {
    actionAfterClose.current = action;
    setOpen(false);
  };
  const run = (action: string) => {
    closeThenRun(() => runAction(action));
  };
  const actions: { id: string; label: string; shortcut: string }[] = [
    { id: 'new', label: 'New Chat', shortcut: 'Ctrl N' },
    { id: 'folder', label: 'Open folder', shortcut: '' },
    { id: 'profile', label: 'Switch profile', shortcut: '' },
    { id: 'density', label: `Toggle density (${density})`, shortcut: '' },
    { id: 'sidebar', label: 'Toggle sidebar', shortcut: 'Ctrl+B' },
    { id: 'panel', label: 'Toggle right panel', shortcut: 'Ctrl+.' },
    { id: 'terminal', label: 'Toggle terminal', shortcut: 'Ctrl+`' },
    { id: 'theme', label: 'Toggle theme', shortcut: '' },
    { id: 'model', label: 'Switch model', shortcut: '' },
    { id: 'explore', label: 'Go to Models', shortcut: '' },
    ...(['All', 'Free', 'Needs attention', 'Configured'] as const).map((filter) => ({
      id: `explore:${filter}`,
      label: `Filter providers: ${filter}`,
      shortcut: '',
    })),
    { id: 'usage', label: 'Go to Usage', shortcut: '' },
    { id: 'library', label: 'Go to Library', shortcut: '' },
    { id: 'settings', label: 'Go to Settings', shortcut: '' },
    ...[
      'General',
      'Profiles',
      'Providers & Keys',
      'Gateway',
      'Advanced',
      'Optimizers',
      'Delegation',
      'Permissions',
      'Skills',
      'MCP',
      'Data & Privacy',
      'Developer',
      'About',
    ].map((section) => ({
      id: `settings:${section}`,
      label: `Settings ${section}`,
      shortcut: '',
    })),
    { id: 'shortcuts', label: 'Keyboard shortcuts', shortcut: 'Ctrl /' },
    { id: 'delegate', label: 'Delegate current task…', shortcut: '' },
    { id: 'checkpoint', label: 'Restore last checkpoint', shortcut: '' },
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setSearchValue('');
      }}
      title="Command palette"
      description="Find a Ferry action, session, or workspace."
      contentClassName="command-dialog"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const action = actionAfterClose.current;
        actionAfterClose.current = null;
        if (action) window.requestAnimationFrame(() => void action());
      }}
    >
      {PaletteCommand ? (
        <PaletteCommand
          label="Command palette"
          className="command-palette"
          filter={scorePaletteMatch}
        >
          <div className="command-search">
            <Search size={15} />
            <PaletteCommand.Input
              autoFocus
              value={searchValue}
              onValueChange={setSearchValue}
              placeholder="Search actions and sessions…"
            />
          </div>
          <PaletteCommand.List>
            <PaletteCommand.Empty>No results.</PaletteCommand.Empty>
            {!searchValue.trim().startsWith('>') && (
              <PaletteCommand.Group heading="Recent sessions">
                {sessions
                  .slice()
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .map((session) => (
                    <PaletteCommand.Item
                      key={`recent-${session.id}`}
                      value={`${session.title} ${session.preview} ${session.id}`}
                      onSelect={() => {
                        closeThenRun(() => {
                          useUI.getState().openTab({ id: session.id, title: session.title });
                          void navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
                        });
                      }}
                    >
                      {session.title}
                      <small>{session.preview}</small>
                    </PaletteCommand.Item>
                  ))}
              </PaletteCommand.Group>
            )}
            {!searchValue.trim().startsWith('>') && (
              <PaletteCommand.Group heading="Workspaces">
                {workspaces.map((workspace) => (
                  <PaletteCommand.Item
                    key={workspace.id}
                    value={`${workspace.name} ${workspace.path}`}
                    onSelect={() => {
                      closeThenRun(() => {
                        localStorage.setItem('ferry.libraryWorkspace', workspace.id);
                        void navigate({ to: '/library' });
                      });
                    }}
                  >
                    {workspace.name}
                    <small>{workspace.path}</small>
                  </PaletteCommand.Item>
                ))}
              </PaletteCommand.Group>
            )}
            <PaletteCommand.Group heading="Commands">
              {actions.map(({ id, label, shortcut }) => (
                <PaletteCommand.Item
                  key={id}
                  value={label}
                  aria-label={label}
                  onSelect={() => {
                    run(id);
                  }}
                >
                  {label}
                  <kbd>{shortcut}</kbd>
                </PaletteCommand.Item>
              ))}
            </PaletteCommand.Group>
          </PaletteCommand.List>
        </PaletteCommand>
      ) : (
        <div className="command-palette" role="status">
          Loading actions…
        </div>
      )}
    </Dialog>
  );
}

export function ComposerModelChip({
  sessionId,
  profileName = 'Profile',
  activeProfileId,
  modelName,
  mode,
  open: controlledOpen,
  onOpenChange,
  profiles = [],
  onProfileSelect,
  onModelSelect,
}: {
  sessionId: SessionId | null;
  profileName?: string;
  activeProfileId?: ProfileId;
  modelName: string;
  mode: 'auto' | 'manual';
  profiles?: { id: ProfileId; name: string; pinned: boolean }[];
  onProfileSelect?: (profileId: ProfileId) => void;
  onModelSelect?: (ref: ModelRef | 'auto') => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const dialogId = useId();
  const client = useFerryClient();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const [localOpen, setLocalOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [commandValue, setCommandValue] = useState('');
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const candidateQueryKey = useMemo(() => ['model-candidates', sessionId] as const, [sessionId]);
  const { data: candidates = [] } = useQuery({
    queryKey: candidateQueryKey,
    queryFn: () => client.models.candidates(sessionId),
    staleTime: 20_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => listAllModels(client),
  });
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const candidateSnapshot = useRef(candidates);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) candidateSnapshot.current = candidates;
  if (!open) candidateSnapshot.current = candidates;
  wasOpen.current = open;
  const visibleCandidates = open ? candidateSnapshot.current : candidates;
  useEffect(() => {
    const openPicker = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId: string }>).detail.sessionId;
      if (id === sessionId) setOpen(true);
    };
    window.addEventListener('ferry:open-model-picker', openPicker);
    return () => {
      window.removeEventListener('ferry:open-model-picker', openPicker);
    };
  }, [sessionId, setOpen]);
  const ModelCommand = useCmdk(open);
  useEffect(() => {
    if (open) {
      const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
      setCommandValue(activeProfile ? `profile ${activeProfile.name}` : '');
    } else {
      setModelQuery('');
    }
  }, [activeProfileId, open, profiles]);
  const autoModel =
    models.find((model) => model.ref === visibleCandidates[0]?.ref)?.name ?? modelName;
  const configuredProviderIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.enabled && ['valid', 'unchecked', 'not_applicable'].includes(provider.keyStatus),
      )
      .map((provider) => provider.id),
  );
  const availableModels = models.filter((model) => configuredProviderIds.has(model.providerId));
  const candidateByRef = new Map(visibleCandidates.map((candidate) => [candidate.ref, candidate]));
  const grouped = useMemo(
    () => [...new Set(availableModels.map((model) => model.providerId))],
    [availableModels],
  );
  const selectionInFlight = useRef<ModelRef | 'auto' | null>(null);
  const select = async (ref: ModelRef | 'auto') => {
    if (selectionInFlight.current === ref) return;
    selectionInFlight.current = ref;
    setOpen(false);
    try {
      if (onModelSelect) onModelSelect(ref);
      else if (sessionId) {
        await client.models.select(sessionId, ref);
        await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
        await cache.invalidateQueries({ queryKey: ['model-candidates', sessionId] });
      }
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Model selection failed',
        body: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpen(false);
      if (selectionInFlight.current === ref) selectionInFlight.current = null;
    }
  };
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          aria-controls={dialogId}
          aria-label={mode === 'auto' ? `Auto · ${autoModel}` : modelName}
          className="v2-composer-chip inline-flex items-center gap-2 rounded-pill px-2 py-1 text-body font-medium text-text-1 hover:bg-icon-circle"
          type="button"
        >
          <FerryMark className="text-text-2" decorative size={14} variant="mono" />
          <span>{profileName}</span>
          <span className="text-text-3">{mode === 'auto' ? `Auto · ${autoModel}` : modelName}</span>
          <ChevronDown aria-hidden="true" size={14} />
        </button>
      </PopoverPrimitive.Trigger>
      {open && ModelCommand ? (
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            aria-label="Choose model"
            className="ferry-ui model-picker-popover"
            collisionPadding={12}
            id={dialogId}
            role="dialog"
            side="top"
            sideOffset={8}
            style={{
              maxHeight: 'min(560px, var(--radix-popover-content-available-height))',
            }}
          >
            <ModelCommand
              label="Choose model"
              className="model-command"
              value={commandValue}
              onValueChange={setCommandValue}
            >
              <ModelCommand.Input
                aria-label="Search models"
                onValueChange={setModelQuery}
                placeholder="Search models…"
                value={modelQuery}
              />
              <ModelCommand.List>
                {profiles.length > 0 ? (
                  <ModelCommand.Group heading="Profile">
                    {profiles.map((profile) => (
                      <ModelCommand.Item
                        className="model-candidate"
                        key={profile.id}
                        value={`profile ${profile.name}`}
                        onSelect={() => {
                          onProfileSelect?.(profile.id);
                          setOpen(false);
                        }}
                      >
                        <strong>{profile.name}</strong>
                        {profile.id === activeProfileId ? (
                          <Check aria-hidden="true" size={14} />
                        ) : (
                          <span>Profile</span>
                        )}
                      </ModelCommand.Item>
                    ))}
                  </ModelCommand.Group>
                ) : null}
                <ModelCommand.Item
                  className="model-candidate auto"
                  value={`Auto ${autoModel}`}
                  onSelect={() => void select('auto')}
                  onClick={() => void select('auto')}
                >
                  <strong>Auto (recommended)</strong>
                  <span>{autoModel} · Router’s current pick</span>
                  <small>
                    {visibleCandidates[0]?.explanation ?? 'Ferry selects the best available model.'}
                  </small>
                </ModelCommand.Item>
                {grouped.map((providerId) => (
                  <ModelCommand.Group
                    key={providerId}
                    heading={
                      providers.find((provider) => provider.id === providerId)?.name ?? providerId
                    }
                  >
                    <ShowMoreList
                      items={availableModels
                        .filter((model) => model.providerId === providerId)
                        .filter((model) => {
                          const providerName =
                            providers.find((provider) => provider.id === providerId)?.name ??
                            providerId;
                          const needle = modelQuery.trim().toLocaleLowerCase();
                          return (
                            !needle ||
                            `${model.name} ${model.ref} ${model.tier} ${providerName}`
                              .toLocaleLowerCase()
                              .includes(needle)
                          );
                        })}
                      groupKey={`model-picker:${providerId}`}
                      label="models"
                      forceExpand={modelQuery.trim().length > 0}
                      renderList={(children) => <>{children}</>}
                      renderItem={(model) => {
                        const candidate = candidateByRef.get(model.ref);
                        const provider = providers.find((item) => item.id === providerId);
                        const capacity = candidate?.stepsLeft ?? provider?.stepsLeftToday ?? null;
                        const why =
                          candidate?.explanation ??
                          `${model.tier} model · ${model.free ? 'Free tier' : 'Paid tier'} · ${String(Math.round(model.contextWindow / 1000))}K context`;
                        return (
                          <ModelCommand.Item
                            className="model-candidate"
                            key={model.ref}
                            value={`${model.name} ${model.tier} ${provider?.name ?? providerId} ${why} ${capacity === null ? '' : String(capacity)}`}
                            onSelect={() => void select(model.ref)}
                            onClick={() => void select(model.ref)}
                          >
                            <strong>
                              {model.name}
                              {provider?.tag === 'promo' ? (
                                <span className="ml-1" title="Promotional — may end without notice">
                                  <TagBadge kind="promo" />
                                </span>
                              ) : null}
                              {provider?.tag === 'trial' ? (
                                <TagBadge className="ml-1" kind="trial" />
                              ) : null}
                              {['anthropic', 'openai-codex', 'github-copilot'].includes(
                                model.providerId,
                              ) ? (
                                <span
                                  className="ml-1 rounded-pill bg-warn/10 px-1.5 py-0.5 text-meta text-warn"
                                  title="Unofficial subscription access may lead to account suspension"
                                  aria-label="Unofficial subscription OAuth; account suspension risk"
                                >
                                  Risk
                                </span>
                              ) : null}
                              {candidate?.selected ? <Check size={13} /> : null}
                            </strong>
                            <ModelQualityBadge model={model} />
                            <span className="model-meta-line">
                              <DataUseBadge dataUse={provider?.dataUse} />{' '}
                              <span className="model-tier-pill">{model.tier}</span>
                              <span className="model-capacity-badge">
                                {capacity == null
                                  ? 'Capacity unknown'
                                  : `≈ ${String(capacity)} steps`}
                              </span>
                              · {Math.round(model.contextWindow / 1000)}K ·{' '}
                              {model.free ? 'Free' : 'Paid'}
                            </span>
                          </ModelCommand.Item>
                        );
                      }}
                    />
                  </ModelCommand.Group>
                ))}
              </ModelCommand.List>
            </ModelCommand>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      ) : null}
    </PopoverPrimitive.Root>
  );
}
