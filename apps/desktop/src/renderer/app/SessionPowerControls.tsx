import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { Bell, Check, ChevronDown, Search, X } from 'lucide-react';
import { Dialog, FerryMark, Pill } from '@ferry/ui';
import type { ModelRef, PartId, SessionId } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { keys, useSessions, useWorkspaces } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';

export function SessionPowerControls() {
  return (
    <>
      <ApprovalsTray />
      <CommandPalette />
    </>
  );
}

function ApprovalsTray() {
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
  const pending = details.flatMap((query) => {
    const detail = query.data;
    if (!detail) return [];
    return detail.messages.flatMap((message) =>
      message.parts
        .filter((part) => part.type === 'approval_request' && part.state === 'pending')
        .map((part) => ({ session: detail.session, part })),
    );
  });
  const respond = async (sessionId: SessionId, partId: string, decision: 'allow_once' | 'deny') => {
    await client.approvals.respond(sessionId, partId as PartId, decision);
    await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
  };
  return (
    <div className="relative">
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
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-warn px-1 text-center text-[10px] leading-4 text-[var(--bg-app)]">
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
  );
}

export function CommandPalette() {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const { data: sessions = [] } = useSessions();
  const { data: workspaces = [] } = useWorkspaces();
  const activeId = useUI((state) => state.activeId);
  const density = useUI((state) => state.density);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, []);
  const run = async (action: string) => {
    setOpen(false);
    switch (action) {
      case 'new': {
        const workspace = workspaces[0];
        if (!workspace) {
          pushToast({ kind: 'warning', title: 'Add a folder first', body: null });
          return;
        }
        const session = await client.sessions.create({ workspaceId: workspace.id });
        useUI.getState().openTab({ id: session.id, title: session.title });
        await cache.invalidateQueries({ queryKey: keys.sessions });
        await navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
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
      case 'explore':
        await navigate({ to: '/explore' });
        break;
      case 'usage':
        await navigate({ to: '/explore/usage' });
        break;
      case 'library':
        await navigate({ to: '/library' });
        break;
      case 'settings':
        await navigate({ to: '/settings' });
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
  const actions: { id: string; label: string; shortcut: string }[] = [
    { id: 'new', label: 'New chat', shortcut: 'Ctrl N' },
    { id: 'folder', label: 'Open folder', shortcut: '' },
    { id: 'profile', label: 'Switch profile', shortcut: '' },
    { id: 'density', label: `Toggle density (${density})`, shortcut: '' },
    { id: 'explore', label: 'Go to Explore', shortcut: '' },
    { id: 'usage', label: 'Go to Usage', shortcut: '' },
    { id: 'library', label: 'Go to Library', shortcut: '' },
    { id: 'settings', label: 'Go to Settings', shortcut: '' },
    { id: 'delegate', label: 'Delegate current task…', shortcut: '' },
    { id: 'checkpoint', label: 'Restore last checkpoint', shortcut: '' },
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Find a Ferry action, session, or workspace."
      contentClassName="command-dialog"
    >
      <Command label="Command palette" className="command-palette">
        <div className="command-search">
          <Search size={15} />
          <Command.Input autoFocus placeholder="Search actions and sessions…" />
        </div>
        <Command.List>
          <Command.Empty>No results.</Command.Empty>
          <Command.Group heading="Actions">
            {actions.map(({ id, label, shortcut }) => (
              <Command.Item key={id} value={label} onSelect={() => void run(id)}>
                {label}
                <kbd>{shortcut}</kbd>
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Recent sessions">
            {sessions
              .slice()
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((session) => (
                <Command.Item
                  key={session.id}
                  value={`${session.title} ${session.preview}`}
                  onSelect={() => {
                    setOpen(false);
                    useUI.getState().openTab({ id: session.id, title: session.title });
                    void navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
                  }}
                >
                  {session.title}
                  <small>{session.preview}</small>
                </Command.Item>
              ))}
          </Command.Group>
          <Command.Group heading="Workspaces">
            {workspaces.map((workspace) => (
              <Command.Item
                key={workspace.id}
                value={`${workspace.name} ${workspace.path}`}
                onSelect={() => {
                  setOpen(false);
                  localStorage.setItem('ferry.libraryWorkspace', workspace.id);
                  void navigate({ to: '/library' });
                }}
              >
                {workspace.name}
                <small>{workspace.path}</small>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </Dialog>
  );
}

export function ModelPickerPopover({
  sessionId,
  modelName,
  mode,
}: {
  sessionId: SessionId;
  modelName: string;
  mode: 'auto' | 'manual';
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const { data: candidates = [] } = useQuery({
    queryKey: ['model-candidates', sessionId],
    queryFn: () => client.models.candidates(sessionId),
  });
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => client.models.list(),
  });
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const autoModel = models.find((model) => model.ref === candidates[0]?.ref)?.name ?? modelName;
  const grouped = useMemo(
    () => [
      ...new Set(
        candidates.map(
          (candidate) => models.find((model) => model.ref === candidate.ref)?.providerId ?? 'other',
        ),
      ),
    ],
    [candidates, models],
  );
  const select = async (ref: ModelRef | 'auto') => {
    await client.models.select(sessionId, ref);
    await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
    await cache.invalidateQueries({ queryKey: ['model-candidates', sessionId] });
    setOpen(false);
  };
  return (
    <div className="relative">
      <button
        className="inline-flex items-center gap-2 rounded-pill px-2 py-1 text-body font-medium text-text-1 hover:bg-icon-circle"
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <FerryMark className="text-text-2" decorative size={14} variant="mono" />
        <span>
          {mode === 'auto' ? 'Auto' : 'Manual'} · {modelName}
        </span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open && (
        <div aria-label="Choose model" className="model-picker-popover" role="dialog">
          <Command label="Choose model" className="model-command">
            <Command.Input placeholder="Search models…" />
            <Command.List>
              <Command.Item
                className="model-candidate auto"
                value={`Auto ${autoModel}`}
                onSelect={() => void select('auto')}
              >
                <strong>Auto (recommended)</strong>
                <span>{autoModel} · Router’s current pick</span>
                <small>
                  {candidates[0]?.explanation ?? 'Ferry selects the best available model.'}
                </small>
              </Command.Item>
              {grouped.map((providerId) => (
                <Command.Group
                  key={providerId}
                  heading={
                    providers.find((provider) => provider.id === providerId)?.name ?? providerId
                  }
                >
                  {candidates
                    .filter(
                      (candidate) =>
                        (models.find((model) => model.ref === candidate.ref)?.providerId ??
                          'other') === providerId,
                    )
                    .map((candidate) => {
                      const model = models.find((item) => item.ref === candidate.ref);
                      if (!model) return null;
                      return (
                        <Command.Item
                          className="model-candidate"
                          key={candidate.ref}
                          value={`${model.name} ${model.tier} ${candidate.explanation}`}
                          onSelect={() => void select(candidate.ref)}
                        >
                          <strong>
                            {model.name}
                            {candidate.selected ? <Check size={13} /> : null}
                          </strong>
                          <span>
                            <span className="model-tier-pill">{model.tier}</span> ·{' '}
                            {candidate.stepsLeft == null
                              ? 'steps unknown'
                              : `${String(candidate.stepsLeft)} steps left`}{' '}
                            · {Math.round(model.contextWindow / 1000)}K ·{' '}
                            {model.free ? 'Free' : 'Paid'}
                          </span>
                          <small>{candidate.explanation}</small>
                        </Command.Item>
                      );
                    })}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </div>
      )}
    </div>
  );
}
