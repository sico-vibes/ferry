import { isOpenCodeAppModel } from '@ferry/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Bell,
  Check,
  ChevronDown,
  FileSearch,
  FileText,
  FolderOpen,
  MessageSquareText,
  Network,
  Search,
  Settings2,
  SquarePen,
  X,
} from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { Dialog, FerryMark, ProviderLogo, ShowMoreList, Skeleton, TagBadge, UiV2 } from '@ferry/ui';
import { DIRECT_PROFILE_ID } from '@ferry/shared';
import type {
  CliOption,
  ModelInfo,
  ModelRef,
  PartId,
  Profile,
  ProfileId,
  SessionDetail,
  SessionId,
} from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { listAllModels } from '@ferry/client';
import { keys, useSessions, useWorkspaces } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI, type SettingsSection } from '../state/ui';
import { settingsSections } from '../state/ui.types';
import { openProjectFolder } from '../data/projects';
import { insertIntoComposer } from '../data/composerInsert';
import { ModelDetailsCard } from './ModelDetailsCard';
import { PickerDetails } from './PickerDetails';
import { CliOptionsChip } from './CliOptionsChip';
import { formatTokens } from './modelFacts';
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
  const [open, setOpen] = useState(false);
  const { data: snapshot } = useQuery({
    queryKey: ['pending-approvals'],
    queryFn: () => client.approvals.pending(),
    retry: false,
  });
  useEffect(() => {
    const refresh = () => {
      void cache.invalidateQueries({ queryKey: ['pending-approvals'] });
    };
    const offRequest = client.on('approval.request', refresh);
    const offPart = client.on('session.part', ({ part }) => {
      if (part.type === 'approval_request') refresh();
    });
    const offRemove = client.on('session.removed', refresh);
    return () => {
      offRequest();
      offPart();
      offRemove();
    };
  }, [client, cache]);
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
  const pending = (snapshot?.entries ?? []).filter((entry) => entry.sessionId !== activeSessionId);
  const respond = async (sessionId: SessionId, partId: string, decision: 'allow_once' | 'deny') => {
    await client.approvals.respond(sessionId, partId as PartId, decision);
    await Promise.all([
      cache.invalidateQueries({ queryKey: keys.session(sessionId) }),
      cache.invalidateQueries({ queryKey: ['pending-approvals'] }),
    ]);
  };
  return pending.length ? (
    <div className="relative v2-approvals-anchor">
      <button
        aria-label={`Notifications${pending.length ? `, ${String(pending.length)} pending` : ''}`}
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
          {pending.map((entry) => (
            <article key={`${entry.sessionId}-${entry.partId}`}>
              <strong>{entry.title}</strong>
              <p>{entry.summary}</p>
              <small>{entry.risk} risk</small>
              <div>
                <UiV2.Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    void respond(entry.sessionId, entry.partId, 'allow_once');
                  }}
                >
                  Allow once
                </UiV2.Button>
                <UiV2.Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void respond(entry.sessionId, entry.partId, 'deny');
                  }}
                >
                  Deny
                </UiV2.Button>
                <button
                  className="text-primary text-meta"
                  onClick={() => {
                    void navigate({ to: '/s/$sessionId', params: { sessionId: entry.sessionId } });
                    setOpen(false);
                  }}
                >
                  Open session
                </button>
              </div>
            </article>
          ))}
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
  // "files" searches the current project's files and inserts an @mention into the composer.
  const [mode, setMode] = useState<'all' | 'files'>('all');
  const selectedWorkspaceId = useUI((state) => state.selectedWorkspaceId);
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
      const context = {
        editableFocus,
        terminalFocus,
        paletteOpen: open,
        isDesktop: Boolean(window.ferryHost),
      };
      const binding = bindings.find((item) => item.command === 'palette.open');
      const filesBinding = bindings.find((item) => item.command === 'files.search');
      if (binding && matchesKeybinding(binding, event, context)) {
        event.preventDefault();
        setMode('all');
        setOpen((value) => !value);
      } else if (filesBinding && matchesKeybinding(filesBinding, event, context)) {
        event.preventDefault();
        setSearchValue('');
        setMode('files');
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    const openPalette = () => {
      setMode('all');
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
      useUI.getState().openSettings(action.slice('settings:'.length) as SettingsSection);
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
        if (await openProjectFolder(client, cache)) await navigate({ to: '/' });
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
      case 'settings':
        useUI.getState().openSettings();
        break;
      case 'shortcuts':
        window.dispatchEvent(new Event('ferry:show-shortcuts'));
        break;
      case 'delegate':
        useUI.getState().setRightTab('plan');
        if (useUI.getState().rightCollapsed) useUI.getState().toggleRight();
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
  const query = searchValue.trim();
  const searching = query.length > 0;
  // Files come from the open chat's project, or the project picked for the next chat.
  const currentProjectId =
    sessions.find((session) => session.id === activeId)?.workspaceId ?? selectedWorkspaceId;
  const currentProject = workspaces.find((workspace) => workspace.id === currentProjectId);
  const { data: fileResults = [] } = useQuery({
    queryKey: ['palette-files', currentProject?.id, query],
    queryFn: () =>
      currentProject
        ? client.workspaces.searchFiles({ workspaceId: currentProject.id, query, limit: 30 })
        : Promise.resolve([]),
    enabled: open && mode === 'files' && Boolean(currentProject),
  });
  // Message text matches (titles are already matched client-side).
  const { data: messageResults = [] } = useQuery({
    queryKey: ['palette-message-search', query],
    queryFn: () => client.sessions.search({ query }),
    enabled: open && mode === 'all' && query.length >= 2 && !query.startsWith('>'),
  });
  const allChats = sessions.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Idle: a few recent chats so actions and settings stay in view; searching covers every chat.
  const recentChats = searching ? allChats : allChats.slice(0, 6);
  // Chats without a project (Recents) show no project name.
  const projectName = (workspaceId: string | null | undefined) =>
    workspaceId ? (workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? '') : '';
  const openChat = (sessionId: SessionId, title: string) => {
    closeThenRun(() => {
      useUI.getState().openTab({ id: sessionId, title });
      void navigate({ to: '/s/$sessionId', params: { sessionId } });
    });
  };
  // Alt+1…6 opens the matching recent chat while the palette is open (shown next to each row).
  useEffect(() => {
    if (!open || searching || mode !== 'all') return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const digit = Number(event.key);
      const chat = Number.isInteger(digit) && digit >= 1 ? recentChats[digit - 1] : undefined;
      if (!chat) return;
      event.preventDefault();
      openChat(chat.id, chat.title);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });
  const quickActions: { id: string; label: string; shortcut: string; icon: typeof Search }[] = [
    { id: 'new', label: 'New chat', shortcut: 'Ctrl+N', icon: SquarePen },
    { id: 'folder', label: 'Open folder', shortcut: 'Ctrl+O', icon: FolderOpen },
    { id: 'files', label: 'Search files', shortcut: 'Ctrl+P', icon: FileSearch },
  ];
  const settingsShortcuts: SettingsSection[] = searching
    ? [...settingsSections]
    : ['General', 'Notifications', 'Providers & keys'];
  const actions: { id: string; label: string; shortcut: string }[] = [
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
    { id: 'settings', label: 'Go to Settings', shortcut: 'Ctrl+,' },
    { id: 'shortcuts', label: 'Keyboard shortcuts', shortcut: 'Ctrl+/' },
    { id: 'delegate', label: 'Delegate current task…', shortcut: '' },
    { id: 'checkpoint', label: 'Restore last checkpoint', shortcut: '' },
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          setSearchValue('');
          setMode('all');
        }
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
              placeholder={
                mode === 'files'
                  ? currentProject
                    ? `Search files in ${currentProject.name}`
                    : 'Search files'
                  : 'Search chats'
              }
            />
          </div>
          <PaletteCommand.List>
            <PaletteCommand.Empty>
              {mode === 'files' && !currentProject
                ? 'Open a chat in a project, or pick a project, to search its files.'
                : 'No results.'}
            </PaletteCommand.Empty>
            {mode === 'files' && fileResults.length > 0 && (
              <PaletteCommand.Group heading="Files">
                {fileResults.map((file) => (
                  <PaletteCommand.Item
                    key={file.path}
                    // The engine already ranked these by the query; keep them all visible.
                    value={`${query} ${file.path}`}
                    onSelect={() => {
                      closeThenRun(() => {
                        insertIntoComposer(`@${file.path} `);
                      });
                    }}
                  >
                    <FileText aria-hidden="true" />
                    <span className="palette-label">{file.name}</span>
                    <span className="palette-meta">{file.path}</span>
                  </PaletteCommand.Item>
                ))}
              </PaletteCommand.Group>
            )}
            {mode === 'all' && !query.startsWith('>') && recentChats.length > 0 && (
              <PaletteCommand.Group heading="Chats">
                {recentChats.map((session, index) => (
                  <PaletteCommand.Item
                    key={`chat-${session.id}`}
                    className="palette-chat"
                    value={`${session.title} ${projectName(session.workspaceId)} ${session.preview} ${session.id}`}
                    onSelect={() => {
                      openChat(session.id, session.title);
                    }}
                  >
                    <span className="palette-label">{session.title}</span>
                    <span className="palette-meta">{projectName(session.workspaceId)}</span>
                    {!searching ? <kbd>{`Alt+${String(index + 1)}`}</kbd> : null}
                  </PaletteCommand.Item>
                ))}
              </PaletteCommand.Group>
            )}
            {mode === 'all' && messageResults.length > 0 && (
              <PaletteCommand.Group heading="In messages">
                {messageResults.slice(0, 8).map((session) => (
                  <PaletteCommand.Item
                    key={`message-${session.id}`}
                    // The engine matched the query in the message text; keep the row visible.
                    value={`${query} ${session.title} ${session.match} message-${session.id}`}
                    onSelect={() => {
                      openChat(session.id, session.title);
                    }}
                  >
                    <MessageSquareText aria-hidden="true" />
                    <span className="palette-label">
                      {session.title}
                      <small className="palette-snippet">{session.match}</small>
                    </span>
                    <span className="palette-meta">{projectName(session.workspaceId)}</span>
                  </PaletteCommand.Item>
                ))}
              </PaletteCommand.Group>
            )}
            {mode === 'all' && searching && !query.startsWith('>') && workspaces.length > 0 && (
              <PaletteCommand.Group heading="Projects">
                {workspaces.map((workspace) => (
                  <PaletteCommand.Item
                    key={workspace.id}
                    value={`${workspace.name} ${workspace.path}`}
                    onSelect={() => {
                      closeThenRun(() => {
                        useUI.getState().setSelectedWorkspace(workspace.id);
                        useUI.getState().requestComposerFocus();
                        void navigate({ to: '/' });
                      });
                    }}
                  >
                    <FolderOpen aria-hidden="true" />
                    <span className="palette-label">{workspace.name}</span>
                    <span className="palette-meta">{workspace.path}</span>
                  </PaletteCommand.Item>
                ))}
              </PaletteCommand.Group>
            )}
            {mode === 'all' && (
              <PaletteCommand.Group heading="Quick actions">
                {quickActions.map(({ id, label, shortcut, icon: Icon }) => (
                  <PaletteCommand.Item
                    key={id}
                    value={label}
                    aria-label={label}
                    onSelect={() => {
                      if (id === 'files') {
                        setSearchValue('');
                        setMode('files');
                      } else run(id);
                    }}
                  >
                    <Icon aria-hidden="true" />
                    <span className="palette-label">{label}</span>
                    <kbd>{shortcut}</kbd>
                  </PaletteCommand.Item>
                ))}
              </PaletteCommand.Group>
            )}
            {mode === 'all' && (
              <PaletteCommand.Group heading="Settings">
                {settingsShortcuts.map((section) => (
                  <PaletteCommand.Item
                    key={section}
                    value={`Settings ${section}`}
                    aria-label={`Settings ${section}`}
                    onSelect={() => {
                      run(`settings:${section}`);
                    }}
                  >
                    <Settings2 aria-hidden="true" />
                    <span className="palette-label">{section}</span>
                  </PaletteCommand.Item>
                ))}
              </PaletteCommand.Group>
            )}
            {mode === 'all' && searching && (
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
                    <span className="palette-label">{label}</span>
                    {shortcut ? <kbd>{shortcut}</kbd> : null}
                  </PaletteCommand.Item>
                ))}
              </PaletteCommand.Group>
            )}
          </PaletteCommand.List>
        </PaletteCommand>
      ) : (
        <div className="command-palette" role="status">
          <Skeleton rows={4} />
        </div>
      )}
    </Dialog>
  );
}

const noProfileValue = 'profile none no profile';
type ModelAccessFilter = 'free' | 'subscription' | 'all';
const modelAccessStorageKey = 'ferry.modelPicker.accessFilter';
function readModelAccess(): ModelAccessFilter {
  try {
    const stored = localStorage.getItem(modelAccessStorageKey);
    if (stored === 'free' || stored === 'subscription' || stored === 'all') return stored;
    return localStorage.getItem('ferry.modelPicker.freeOnly') === 'true' ? 'free' : 'all';
  } catch {
    return 'all';
  }
}
function saveModelAccess(value: ModelAccessFilter): void {
  try {
    localStorage.setItem(modelAccessStorageKey, value);
  } catch {
    /* Preference only; selection still works without storage. */
  }
}

export function ComposerModelChip({
  sessionId,
  profileName = 'Profile',
  activeProfileId,
  modelName,
  modelRef,
  servedModelRef = null,
  pinnedUnavailable = false,
  mode,
  open: controlledOpen,
  onOpenChange,
  profiles = [],
  onProfileSelect,
  onModelSelect,
  cliOptions,
  onCliOptionsChange,
}: {
  sessionId: SessionId | null;
  profileName?: string;
  activeProfileId?: ProfileId;
  modelName: string;
  modelRef: ModelRef | null;
  servedModelRef?: ModelRef | null;
  pinnedUnavailable?: boolean;
  mode: 'auto' | 'manual';
  profiles?: {
    id: ProfileId;
    name: string;
    pinned: boolean;
    description?: string;
    cliDefaults?: Profile['cliDefaults'];
    provenance?: Profile['provenance'];
  }[];
  onProfileSelect?: (profileId: ProfileId) => void;
  onModelSelect?: (ref: ModelRef | 'auto') => void;
  cliOptions?: CliOption | null;
  onCliOptionsChange?: (options: CliOption) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const dialogId = useId();
  const navigate = useNavigate();
  const client = useFerryClient();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const pendingOptionsFocus = useRef(false);
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  const [optionsModelRef, setOptionsModelRef] = useState<ModelRef | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [commandValue, setCommandValue] = useState('');
  // The details card is a hover tooltip: it follows cmdk's highlight while the pointer is over the
  // list or the arrow keys are in use, and is hidden otherwise.
  const [pointerInList, setPointerInList] = useState(false);
  const [keyboardNav, setKeyboardNav] = useState(false);
  const open = controlledOpen ?? localOpen;
  const profileValue = (profile: { id: ProfileId; name: string }) =>
    `profile ${profile.id} ${profile.name}`;
  const routingProfiles = profiles.filter(
    (profile) =>
      profile.id !== DIRECT_PROFILE_ID &&
      (!profile.provenance?.supersededBy || profile.id === activeProfileId),
  );
  const noProfile = activeProfileId === DIRECT_PROFILE_ID;
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
  const { data: cliConnections = [] } = useQuery({
    queryKey: ['cli-connections'],
    queryFn: () => client.cliConnections.list(),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  const { data: transportSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => client.settings.get(),
    enabled: open,
  });
  const cliNativeReady = (model: ModelInfo) => {
    if (!model.cliConnectionId) return true;
    if (model.providerId === 'opencode' && transportSettings?.opencodeZenTransport === 'cli')
      return model.cliAccessVerified === true;
    const connection = cliConnections.find((item) => item.id === model.cliConnectionId);
    return !!connection?.surfaces.native && connection.verify.state === 'verified';
  };

  const { data: gatewayKeys = [] } = useQuery({
    queryKey: ['gateway-keys'],
    queryFn: () => client.gateway.listKeys(),
    enabled: open || Boolean(modelRef?.startsWith('gateway/')),
  });
  const { data: gatewaySettings } = useQuery({
    queryKey: ['gateway-settings'],
    queryFn: () => client.gateway.settings(),
    enabled: open,
  });
  const usableGatewayKeys = gatewayKeys.filter((key) => key.revokedAt === null);
  const gatewayRunning = gatewaySettings?.status.running ?? false;
  const selectedGatewayKey = modelRef?.startsWith('gateway/')
    ? gatewayKeys.find((key) => `gateway/${key.id}` === modelRef)
    : undefined;
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
      setCommandValue(
        activeProfileId === DIRECT_PROFILE_ID
          ? noProfileValue
          : activeProfile
            ? profileValue(activeProfile)
            : '',
      );
    } else {
      setModelQuery('');
      setPointerInList(false);
      setKeyboardNav(false);
    }
  }, [activeProfileId, open, profiles]);
  const autoRef = visibleCandidates[0]?.ref;
  const autoInfo = models.find((model) => model.ref === autoRef);
  const autoModel = autoInfo?.name ?? (modelName || 'picks per message');
  const pinnedModel = models.find((model) => model.ref === modelRef);
  const servedModel = models.find((model) => model.ref === servedModelRef);
  useEffect(() => {
    setOptionsModelRef(null);
  }, [modelRef]);
  const optionsModel = models.find((model) => model.ref === (optionsModelRef ?? modelRef));
  const sessionOptions = useQuery({
    queryKey: sessionId ? keys.session(sessionId) : ['cli-options-draft'],
    queryFn: () => (sessionId ? client.sessions.get(sessionId) : Promise.resolve(null)),
    enabled: !!sessionId && !!optionsModel?.cliCapabilities,
    staleTime: 10_000,
  });
  const effectiveOptions = optionsModel
    ? (cliOptions ??
      sessionOptions.data?.session.cliOptions?.[optionsModel.ref] ??
      profiles.find((profile) => profile.id === activeProfileId)?.cliDefaults?.[
        optionsModel.ref
      ] ?? { effort: null, speed: 'standard' as const })
    : { effort: null, speed: 'standard' as const };
  const changeCliOptions = async (options: CliOption) => {
    setOptionsBusy(true);
    setOptionsError('');
    try {
      if (onCliOptionsChange) onCliOptionsChange(options);
      else if (sessionId && optionsModel) {
        const session = await client.sessions.updateCliOptions(sessionId, {
          modelRef: optionsModel.ref,
          options,
        });
        cache.setQueryData<SessionDetail>(keys.session(sessionId), (previous) =>
          previous ? { ...previous, session } : previous,
        );
      }
    } catch (cause) {
      setOptionsError(cause instanceof Error ? cause.message : 'Could not change CLI options.');
    } finally {
      setOptionsBusy(false);
    }
  };

  const chipModel = pinnedUnavailable ? servedModel : mode === 'auto' ? autoInfo : pinnedModel;
  // The chip always names the model you picked, never the last model that happened to answer.
  const pinnedRefTail = modelRef?.split('/').at(-1);
  const pinnedName =
    pinnedModel?.name ?? (modelName !== '' ? modelName : (pinnedRefTail ?? 'Choose a model'));
  const chipLabel = selectedGatewayKey
    ? `Gateway · ${selectedGatewayKey.name}`
    : pinnedUnavailable
      ? `Pinned: ${pinnedName} (unavailable) · now ${modelName}`
      : mode === 'auto'
        ? `Auto · ${autoModel}`
        : pinnedName;
  const configuredProviderIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.enabled && ['valid', 'unchecked', 'not_applicable'].includes(provider.keyStatus),
      )
      .map((provider) => provider.id),
  );
  const [accessFilter, setAccessFilter] = useState(readModelAccess);
  const providerExclusions = new Map(
    providers.map((provider) => [provider.id, new Set(provider.excludedModelRefs ?? [])]),
  );
  const connectedModels = models.filter(
    (model) =>
      configuredProviderIds.has(model.providerId) &&
      cliNativeReady(model) &&
      !isOpenCodeAppModel(model) &&
      !providerExclusions.get(model.providerId)?.has(model.ref),
  );
  const availableModels =
    accessFilter === 'free'
      ? connectedModels.filter((model) => model.free)
      : accessFilter === 'subscription'
        ? connectedModels.filter(
            (model) => model.cliCapabilities?.billing === 'included_subscription',
          )
        : connectedModels;
  const zenProvider = providers.find((provider) => provider.id === 'opencode');
  const zenNeedsVerification = [
    ...new Map(
      [...models, ...(zenProvider?.availableModels ?? [])]
        .filter(
          (model) =>
            model.providerId === 'opencode' &&
            isOpenCodeAppModel(model) &&
            zenProvider?.keyStatus !== 'missing',
        )
        .map((model) => [model.ref, model]),
    ).values(),
  ];
  const cliSetupModels = models.filter(
    (model) =>
      model.cliConnectionId &&
      !cliNativeReady(model) &&
      (accessFilter === 'all' ||
        (accessFilter === 'free'
          ? model.free
          : model.cliCapabilities?.billing === 'included_subscription')),
  );
  const candidateByRef = new Map(visibleCandidates.map((candidate) => [candidate.ref, candidate]));
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const grouped = useMemo(
    () => [...new Set(availableModels.map((model) => model.providerId))],
    [availableModels],
  );
  // cmdk reports the highlighted row by its value; map values back to what the card shows.
  const autoValue = `Auto ${autoModel}`;
  const modelValue = (model: ModelInfo) =>
    `${model.name} ${model.tier} ${providerById.get(model.providerId)?.name ?? model.providerId} ${model.ref}`;
  const highlighted = (pointerInList || keyboardNav ? commandValue : '').toLocaleLowerCase();
  const highlightedModel =
    highlighted === autoValue.toLocaleLowerCase()
      ? autoInfo
      : availableModels.find((model) => modelValue(model).toLocaleLowerCase() === highlighted);
  const highlightedProfile = highlighted.startsWith('profile ')
    ? profiles.find((profile) => profileValue(profile).toLocaleLowerCase() === highlighted)
    : undefined;
  const selectionInFlight = useRef<ModelRef | 'auto' | null>(null);
  const select = async (ref: ModelRef | 'auto') => {
    if (selectionInFlight.current === ref) return;
    selectionInFlight.current = ref;
    const chosen = models.find((model) => model.ref === ref);
    setOptionsModelRef(chosen?.cliCapabilities ? chosen.ref : null);
    pendingOptionsFocus.current = !!chosen?.cliCapabilities;
    setOptionsOpen(false);
    setOptionsError('');
    setOpen(false);
    try {
      if (onModelSelect) onModelSelect(ref);
      else if (sessionId) {
        await client.models.select(sessionId, ref);
        await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
        await cache.invalidateQueries({ queryKey: ['model-candidates', sessionId] });
      }
    } catch (error) {
      setOptionsModelRef(null);
      setOptionsOpen(false);
      pendingOptionsFocus.current = false;
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
    <>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger asChild>
          <button
            aria-controls={dialogId}
            aria-label={chipLabel}
            className="v2-composer-chip inline-flex items-center gap-2 rounded-pill px-2 py-1 text-body font-medium text-text-1 hover:bg-icon-circle"
            type="button"
          >
            {noProfile ? null : (
              <>
                <FerryMark className="v2-chip-ferry" decorative size={14} variant="brand" />
                <span className="v2-chip-profile">{profileName}</span>
                <span aria-hidden="true" className="v2-chip-divider" />
              </>
            )}
            {chipModel ? (
              <ProviderLogo
                model={`${chipModel.ref} ${chipModel.name}`}
                name={chipModel.name}
                providerId={chipModel.providerId}
                size={14}
              />
            ) : null}
            <span className="v2-chip-model">
              {pinnedUnavailable ? (
                chipLabel
              ) : mode === 'auto' ? (
                <>
                  <span className="v2-chip-auto">Auto</span>
                  {autoModel}
                </>
              ) : selectedGatewayKey ? (
                chipLabel
              ) : (
                pinnedName
              )}
            </span>
            <ChevronDown aria-hidden="true" size={14} />
          </button>
        </PopoverPrimitive.Trigger>
        {open && ModelCommand ? (
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              align="start"
              aria-label="Choose model"
              className="ferry-ui model-picker-popover"
              // Keep clear of the 44px window title bar; symmetric so the preferred side never flips.
              collisionPadding={{ top: 56, right: 12, bottom: 56, left: 12 }}
              id={dialogId}
              role="dialog"
              onCloseAutoFocus={(event) => {
                // Open options after the model list releases focus, so its cleanup cannot dismiss them.
                if (pendingOptionsFocus.current) {
                  event.preventDefault();
                  pendingOptionsFocus.current = false;
                  setOptionsOpen(true);
                }
              }}
              onPointerLeave={() => {
                setPointerInList(false);
                setKeyboardNav(false);
              }}
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
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setKeyboardNav(true);
                }}
              >
                <div className="model-picker-search">
                  <Search aria-hidden="true" size={14} />
                  <ModelCommand.Input
                    aria-label="Search models"
                    onValueChange={setModelQuery}
                    placeholder="Search models…"
                    value={modelQuery}
                  />
                  <select
                    className="model-picker-access-filter"
                    aria-label="Model access"
                    value={accessFilter}
                    onChange={(event) => {
                      const value = event.target.value as ModelAccessFilter;
                      setAccessFilter(value);
                      saveModelAccess(value);
                    }}
                  >
                    <option value="free">Free</option>
                    <option value="subscription">Included subscriptions</option>
                    <option value="all">All connected</option>
                  </select>
                </div>
                <ModelCommand.List
                  onPointerEnter={() => {
                    setPointerInList(true);
                  }}
                >
                  <ModelCommand.Empty className="model-picker-empty">
                    No models match.
                  </ModelCommand.Empty>
                  <ModelCommand.Group heading="Route">
                    <ModelCommand.Item
                      className="model-candidate auto"
                      value={autoValue}
                      onSelect={() => void select('auto')}
                      onClick={() => void select('auto')}
                    >
                      <FerryMark className="model-row-logo" decorative size={16} variant="brand" />
                      <strong>Auto (recommended)</strong>
                      <span className="model-row-meta">{autoModel}</span>
                      {mode === 'auto' ? (
                        <Check aria-hidden="true" className="model-row-check" size={14} />
                      ) : null}
                    </ModelCommand.Item>
                  </ModelCommand.Group>
                  {onProfileSelect ? (
                    <ModelCommand.Group heading="Profile">
                      <ModelCommand.Item
                        className="model-candidate model-profile"
                        value={noProfileValue}
                        onSelect={() => {
                          onProfileSelect(DIRECT_PROFILE_ID);
                          setOpen(false);
                        }}
                      >
                        <strong>No profile</strong>
                        <span className="model-row-meta">Pick the model yourself</span>
                        {noProfile ? (
                          <Check aria-hidden="true" className="model-row-check" size={14} />
                        ) : null}
                      </ModelCommand.Item>
                      {routingProfiles.map((profile) => (
                        <ModelCommand.Item
                          className="model-candidate model-profile"
                          key={profile.id}
                          value={profileValue(profile)}
                          onSelect={() => {
                            onProfileSelect(profile.id);
                            setOpen(false);
                          }}
                        >
                          <strong>{profile.name}</strong>
                          {profile.provenance?.supersededBy && (
                            <span className="model-row-meta">Previous check</span>
                          )}
                          {profile.id === activeProfileId ? (
                            <Check aria-hidden="true" className="model-row-check" size={14} />
                          ) : null}
                        </ModelCommand.Item>
                      ))}
                    </ModelCommand.Group>
                  ) : null}

                  {usableGatewayKeys.length ? (
                    <ModelCommand.Group
                      heading={
                        <span className="model-group-heading">
                          <Network aria-hidden="true" size={14} />
                          Gateway keys
                          {gatewaySettings && !gatewayRunning ? (
                            <button
                              className="model-picker-filter ml-auto"
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void client.gateway
                                  .setSettings({
                                    enabled: true,
                                    port: gatewaySettings.port,
                                    allowLan: gatewaySettings.allowLan,
                                  })
                                  .then(() =>
                                    cache.invalidateQueries({ queryKey: ['gateway-settings'] }),
                                  );
                              }}
                            >
                              Gateway off · Start
                            </button>
                          ) : null}
                        </span>
                      }
                    >
                      {usableGatewayKeys.map((key) => (
                        <ModelCommand.Item
                          className="model-candidate"
                          key={key.id}
                          value={`gateway ${key.name} ${key.id}`}
                          onSelect={() => void select(`gateway/${key.id}` as ModelRef)}
                          onClick={() => void select(`gateway/${key.id}` as ModelRef)}
                        >
                          <Network aria-hidden="true" className="model-row-logo" size={16} />
                          <strong>{key.name}</strong>
                          <span className="model-row-meta">
                            {key.profile === 'none'
                              ? `${String(key.allowedModels.length)} picked models`
                              : `profile ${key.profile}`}
                          </span>
                          {modelRef === `gateway/${key.id}` ? (
                            <Check aria-hidden="true" className="model-row-check" size={14} />
                          ) : null}
                        </ModelCommand.Item>
                      ))}
                    </ModelCommand.Group>
                  ) : null}
                  {grouped.map((providerId) => {
                    const provider = providerById.get(providerId);
                    const providerName = provider?.name ?? providerId;
                    return (
                      <ModelCommand.Group
                        key={providerId}
                        heading={
                          <span className="model-group-heading">
                            <ProviderLogo name={providerName} providerId={providerId} size={14} />
                            {providerName}
                          </span>
                        }
                      >
                        <ShowMoreList
                          items={availableModels
                            .filter((model) => model.providerId === providerId)
                            .filter((model) => {
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
                            const selected = mode === 'manual' && model.ref === modelRef;
                            return (
                              <ModelCommand.Item
                                className="model-candidate"
                                key={model.ref}
                                value={modelValue(model)}
                                onSelect={() => void select(model.ref)}
                                onClick={() => void select(model.ref)}
                              >
                                <ProviderLogo
                                  className="model-row-logo"
                                  model={`${model.ref} ${model.name}`}
                                  name={model.name}
                                  providerId={model.providerId}
                                  size={16}
                                />
                                <strong>
                                  {model.name}
                                  {model.cliCapabilities?.upstreamProvider && (
                                    <small className="model-picker-upstream">
                                      {model.cliCapabilities.upstreamProvider}
                                    </small>
                                  )}
                                  {provider?.tag === 'promo' ? (
                                    <TagBadge className="ml-1.5" kind="promo" />
                                  ) : null}
                                  {provider?.tag === 'trial' ? (
                                    <TagBadge className="ml-1.5" kind="trial" />
                                  ) : null}
                                  {['anthropic', 'openai-codex', 'github-copilot'].includes(
                                    model.providerId,
                                  ) && provider?.tag === 'subscription_oauth' ? (
                                    <span
                                      className="model-risk-pill"
                                      aria-label="Unofficial subscription OAuth; account suspension risk"
                                    >
                                      Risk
                                    </span>
                                  ) : null}
                                </strong>
                                <span className="model-row-meta">
                                  {formatTokens(model.contextWindow)}
                                  {model.free ? (
                                    <span className="model-free-pill">Free</span>
                                  ) : (
                                    <span className="model-paid-pill">
                                      {model.cliCapabilities?.billing === 'included_subscription'
                                        ? 'Included'
                                        : model.cliCapabilities?.billing === 'metered'
                                          ? 'Metered'
                                          : model.cliCapabilities?.billing === 'unknown'
                                            ? 'Unknown'
                                            : 'Paid'}
                                    </span>
                                  )}
                                </span>
                                {selected || (mode === 'auto' && candidate?.selected) ? (
                                  <Check aria-hidden="true" className="model-row-check" size={14} />
                                ) : null}
                              </ModelCommand.Item>
                            );
                          }}
                        />
                      </ModelCommand.Group>
                    );
                  })}
                  {cliSetupModels.length > 0 && (
                    <ModelCommand.Group heading="Installed CLIs — setup needed">
                      {cliSetupModels.map((model) => (
                        <ModelCommand.Item
                          key={`cli-setup-${model.ref}`}
                          value={`${model.name} ${model.ref}`}
                          disabled
                          className="model-candidate model-picker-unavailable"
                        >
                          <ProviderLogo
                            name={model.name}
                            model={`${model.ref} ${model.name}`}
                            size={16}
                          />
                          <strong>{model.name}</strong>
                          <span className="model-row-meta">
                            {cliConnections.find(
                              (connection) => connection.id === model.cliConnectionId,
                            )?.surfaces.native
                              ? 'Verify access'
                              : 'Enable in Ferry'}
                          </span>
                        </ModelCommand.Item>
                      ))}
                    </ModelCommand.Group>
                  )}
                  {zenNeedsVerification.length > 0 && (
                    <ModelCommand.Group heading="OpenCode Zen — connection unverified">
                      {zenNeedsVerification.map((model) => (
                        <ModelCommand.Item
                          key={`zen-unverified-${model.ref}`}
                          value={`${model.name} OpenCode Zen ${model.ref}`}
                          disabled
                          className="model-candidate model-picker-unavailable"
                        >
                          <ProviderLogo providerId="opencode" name={model.name} size={16} />
                          <strong>{model.name}</strong>
                          <span className="model-risk-pill">Verify access</span>
                        </ModelCommand.Item>
                      ))}
                    </ModelCommand.Group>
                  )}
                </ModelCommand.List>
                {cliSetupModels.length > 0 && (
                  <div className="model-picker-zen-note">
                    <span>CLI connections need an opt-in and generation check.</span>
                    <UiV2.Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setOpen(false);
                        useUI.getState().openSettings('Providers & keys');
                      }}
                    >
                      Manage CLIs
                    </UiV2.Button>
                  </div>
                )}

                {zenNeedsVerification.length > 0 && (
                  <div className="model-picker-zen-note" aria-label="OpenCode Zen availability">
                    <span>{zenNeedsVerification.length} Zen free models need verification.</span>
                    <UiV2.Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setOpen(false);
                        void navigate({ to: '/models' });
                      }}
                    >
                      Check Zen access
                    </UiV2.Button>
                  </div>
                )}
              </ModelCommand>
              <PickerDetails>
                {highlightedModel ? (
                  <ModelDetailsCard
                    auto={
                      highlightedModel === autoInfo && highlighted === autoValue.toLocaleLowerCase()
                    }
                    candidate={candidateByRef.get(highlightedModel.ref)}
                    model={highlightedModel}
                    provider={providerById.get(highlightedModel.providerId)}
                  />
                ) : highlighted === noProfileValue.toLocaleLowerCase() ? (
                  <aside aria-label="No profile" className="v2-model-details">
                    <header>
                      <strong>No profile</strong>
                      <span className="v2-model-details-provider">Direct model</span>
                    </header>
                    <p className="v2-model-details-description">
                      Talk to the model you pick, with no routing rules. Auto picks from every
                      connected model. Your global paid confirmation and spend caps still apply.
                    </p>
                  </aside>
                ) : highlightedProfile ? (
                  <aside
                    aria-label={`${highlightedProfile.name} profile`}
                    className="v2-model-details"
                  >
                    <header>
                      <strong>{highlightedProfile.name}</strong>
                      <span className="v2-model-details-provider">Routing profile</span>
                    </header>
                    <p className="v2-model-details-description">
                      {highlightedProfile.description ??
                        'Ferry picks a model for each step using this profile’s rules.'}
                    </p>
                  </aside>
                ) : null}
              </PickerDetails>
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        ) : null}
      </PopoverPrimitive.Root>
      {optionsModel?.cliCapabilities && (
        <CliOptionsChip
          model={optionsModel}
          value={{
            effort: effectiveOptions.effort ?? null,
            speed: effectiveOptions.speed,
          }}
          open={optionsOpen}
          onOpenChange={setOptionsOpen}
          onChange={(options) => void changeCliOptions(options)}
          busy={optionsBusy}
          error={optionsError}
        />
      )}
    </>
  );
}
