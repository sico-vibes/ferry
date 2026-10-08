import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { FerryClient } from '@ferry/client';
import { ModelRefSchema } from '@ferry/shared';
import type {
  Effort,
  Message,
  Profile,
  ProviderHealthSnapshot,
  ProviderLimits,
  Session,
  SessionId,
  Workspace,
} from '@ferry/shared';
import { bad, good, gradient, muted, warn } from './format.js';
import { executeSlashCommand, parseSlashCommand } from './slash.js';
import { Picker, type PickerOption } from './components/picker.js';
import { Composer } from './components/composer.js';
import { SettingsPanel } from './components/settings-panel.js';
import { StatusBar } from './components/status-bar.js';
import { Transcript, type TranscriptEntry } from './components/transcript.js';
import {
  effortOptions,
  modelOptions,
  profileOptions,
  projectOptions,
  sessionOptions,
} from './picker-options.js';
import { fileMentions, readAttachments } from './attachments.js';

/* Ink callbacks intentionally return void; failures are rendered in the transcript. */
/* eslint-disable @typescript-eslint/no-confusing-void-expression */
interface Panel {
  name: string;
  title: string;
  options: PickerOption[];
}

export function Chat({
  client,
  workspace,
  profile,
  engine = 'local',
  initialSession,
}: {
  client: FerryClient;
  workspace: Workspace | null;
  profile: Profile | undefined;
  engine?: 'local' | 'mock';
  initialSession?: Session;
}) {
  const { exit } = useApp();
  const [project, setProject] = useState(workspace);
  const [activeProfile, setActiveProfile] = useState(profile);
  const [model, setModel] = useState(initialSession?.pinnedModelRef ?? 'auto');
  const [servedModel, setServedModel] = useState(initialSession?.modelRef ?? null);
  const [effort, setEffort] = useState<Effort | null>(initialSession?.effort ?? null);
  const sessionRef = useRef<SessionId | null>(initialSession?.id ?? null);
  const creation = useRef<Promise<SessionId> | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [limits, setLimits] = useState<ProviderLimits[]>([]);
  const [health, setHealth] = useState<ProviderHealthSnapshot[]>([]);
  const [contextTokens, setContextTokens] = useState<number | null>(null);
  const [replyTokens, setReplyTokens] = useState<number | null>(null);
  const [contextWindow, setContextWindow] = useState<number>();
  const [approval, setApproval] = useState<Extract<
    import('@ferry/shared').MessagePart,
    { type: 'approval_request' }
  > | null>(null);
  const [passwordEmail, setPasswordEmail] = useState<string | null>(null);
  const [cloudEmail, setCloudEmail] = useState<string | null>(null);
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const ctrlC = useRef(0);
  const ctrlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRequest = useRef(0);
  const wasRunning = useRef(false);
  const notice = (text: string) =>
    setEntries((old) => [
      ...old,
      { id: `notice-${String(Date.now())}-${String(old.length)}`, text },
    ]);
  const showError = (error: unknown) =>
    notice(bad(error instanceof Error ? error.message : String(error)));
  const closePanel = () => {
    panelRequest.current++;
    setPanel(null);
  };
  const pressCtrlC = () => {
    ctrlC.current++;
    if (ctrlC.current >= 2) exit();
    if (ctrlTimer.current) clearTimeout(ctrlTimer.current);
    ctrlTimer.current = setTimeout(() => {
      ctrlC.current = 0;
    }, 1000);
  };
  const ctrlHandler = useRef(pressCtrlC);
  ctrlHandler.current = pressCtrlC;

  function receive(message: Message) {
    setEntries((old) => {
      let next = old.filter(
        (entry) =>
          !(
            entry.id.startsWith('pending-') &&
            message.role === 'user' &&
            entry.text === message.parts.find((part) => part.type === 'text')?.text
          ),
      );
      for (const part of message.parts) {
        const entry: TranscriptEntry =
          part.type === 'text'
            ? { id: part.id, role: message.role, text: part.text }
            : { id: part.id, part };
        const index = next.findIndex((row) => row.id === part.id);
        if (index >= 0) next = next.map((row, i) => (i === index ? { ...row, ...entry } : row));
        else next = [...next, entry];
      }
      return next;
    });
  }
  useEffect(() => {
    const onSignal = () => ctrlHandler.current();
    process.on('SIGINT', onSignal);
    return () => {
      process.off('SIGINT', onSignal);
      if (ctrlTimer.current) clearTimeout(ctrlTimer.current);
    };
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([client.quota.limits(), client.providers.health(), client.cloud.status()])
      .then(([quota, providers, cloud]) => {
        if (!active) return;
        setLimits(quota);
        setHealth(providers);
        setCloudEmail(cloud.auth.signedIn ? cloud.auth.email : null);
      })
      .catch(showError);
    const off = [
      client.on('session.delta', (event) => {
        if (event.sessionId !== sessionRef.current) return;
        setEntries((old) =>
          old.some((row) => row.id === event.partId)
            ? old.map((row) =>
                row.id === event.partId
                  ? { ...row, text: (row.text ?? '') + event.textDelta }
                  : row,
              )
            : [...old, { id: event.partId, role: 'assistant', text: event.textDelta }],
        );
      }),
      client.on('session.message', ({ sessionId, message }) => {
        if (sessionId === sessionRef.current) receive(message);
      }),
      client.on('session.part', ({ sessionId, part }) => {
        if (sessionId !== sessionRef.current) return;
        setEntries((old) => {
          const entry: TranscriptEntry =
            part.type === 'text'
              ? { id: part.id, role: 'assistant', text: part.text }
              : { id: part.id, part };
          return old.some((row) => row.id === part.id)
            ? old.map((row) => (row.id === part.id ? { ...row, ...entry } : row))
            : [...old, entry];
        });
        if (part.type === 'approval_request') setApproval(part.state === 'pending' ? part : null);
      }),
      client.on('session.updated', (value) => {
        if (value.id !== sessionRef.current) return;
        setServedModel(value.modelRef);
        setEffort(value.effort ?? null);
        const working = value.status === 'running' || value.status === 'awaiting_approval';
        setRunning(working);
        if (wasRunning.current && !working) {
          setApproval(null);
          void client.sessions
            .get(value.id)
            .then(({ messages }) => {
              if (sessionRef.current !== value.id) return;
              for (const message of messages) receive(message);
              setEntries((old) =>
                old.map((entry) => {
                  const answer = messages.find(
                    (message) =>
                      message.role === 'assistant' && message.parts.at(-1)?.id === entry.id,
                  );
                  return answer?.modelRef ? { ...entry, via: answer.modelRef } : entry;
                }),
              );
            })
            .catch(showError);
          void client.quota.limits().then(setLimits).catch(showError);
        }
        wasRunning.current = working;
      }),
      client.on('agent.event', ({ sessionId, event }) => {
        if (sessionId === sessionRef.current && event.type === 'usage') {
          setContextTokens(event.inputTokens ?? null);
          setReplyTokens((old) =>
            event.outputTokens === undefined ? old : (old ?? 0) + event.outputTokens,
          );
        }
      }),
      client.on('quota.limits.updated', setLimits),
      client.on('providers.health.updated', (snapshot) =>
        setHealth((old) => [
          ...old.filter((row) => row.providerId !== snapshot.providerId),
          snapshot,
        ]),
      ),
    ];
    return () => {
      active = false;
      for (const dispose of off) dispose();
    };
  }, [client]);
  useEffect(() => {
    let active = true;
    void client.models
      .list()
      .then((models) => {
        if (active)
          setContextWindow(models.find((row) => row.ref === (servedModel ?? model))?.contextWindow);
      })
      .catch(showError);
    return () => {
      active = false;
    };
  }, [client, model, servedModel]);
  useEffect(() => {
    if (initialSession) void loadSession(initialSession.id).catch(showError);
  }, []);
  useEffect(() => {
    const match = /(?:^|\s)@([^\s]*)$/.exec(input);
    if (!match || !project || passwordEmail !== null) {
      setFiles([]);
      return;
    }
    let active = true;
    void client.workspaces
      .searchFiles({ workspaceId: project.id, query: match[1] ?? '', limit: 20 })
      .then((rows) => {
        if (active) setFiles(rows);
      })
      .catch(showError);
    return () => {
      active = false;
    };
  }, [client, input, project, passwordEmail]);
  useInput((value, key) => {
    if (key.ctrl && value === 'c') pressCtrlC();
    if (key.escape && running && sessionRef.current)
      void client.sessions.cancel(sessionRef.current).catch(showError);
    if (panel || settingsOpen) return;
    if (key.pageUp) setOffset((old) => Math.min(entries.length, old + 10));
    if (key.pageDown) setOffset((old) => Math.max(0, old - 10));
    if (approval && ['y', 'n', 'a'].includes(value.toLowerCase()) && sessionRef.current) {
      const decision =
        value.toLowerCase() === 'n'
          ? 'deny'
          : value.toLowerCase() === 'a'
            ? 'allow_always'
            : 'allow_once';
      void client.approvals
        .respond(sessionRef.current, approval.id, decision)
        .then(() => setApproval(null))
        .catch(showError);
    }
  });

  async function createSession(): Promise<SessionId> {
    if (sessionRef.current) return sessionRef.current;
    if (creation.current) return await creation.current;
    creation.current = client.sessions
      .create({
        workspaceId: project?.id ?? null,
        ...(activeProfile ? { profileId: activeProfile.id } : {}),
        title: 'New Chat',
      })
      .then(async (next) => {
        sessionRef.current = next.id;
        if (model !== 'auto') await client.models.select(next.id, ModelRefSchema.parse(model));
        if (effort) await client.sessions.setEffort(next.id, effort);
        return next.id;
      })
      .catch((error: unknown) => {
        creation.current = null;
        throw error;
      });
    return await creation.current;
  }
  async function newChat(nextProject: Workspace | null, chooseProject = true) {
    if (chooseProject && nextProject && !nextProject.trusted) {
      setPanel({
        name: `trust:${nextProject.id}`,
        title: `Trust ${nextProject.path}?${nextProject.riskyRoot ? ' Warning: risky workspace root.' : ''}`,
        options: [
          { value: nextProject.id, label: 'Trust project' },
          { value: 'cancel', label: 'Cancel' },
        ],
      });
      return;
    }
    const next = await client.sessions.create({
      workspaceId: nextProject?.id ?? null,
      ...(activeProfile ? { profileId: activeProfile.id } : {}),
      title: 'New Chat',
    });
    sessionRef.current = next.id;
    creation.current = null;
    setProject(nextProject);
    setEntries([]);
    setModel('auto');
    setServedModel(null);
    setEffort(null);
    setContextTokens(null);
    setReplyTokens(null);
    setOffset(0);
    setAttachments([]);
    setApproval(null);
    wasRunning.current = false;
    closePanel();
    notice('Started a fresh chat.');
  }
  async function loadSession(id: SessionId) {
    const detail = await client.sessions.get(id);
    const projects = await client.workspaces.list();
    sessionRef.current = id;
    creation.current = null;
    setProject(projects.find((row) => row.id === detail.session.workspaceId) ?? null);
    const profiles = await client.profiles.list();
    setActiveProfile(profiles.find((row) => row.id === detail.session.profileId));
    setModel(detail.session.pinnedModelRef ?? 'auto');
    setServedModel(detail.session.modelRef);
    setEffort(detail.session.effort ?? null);
    setEntries(
      detail.messages.flatMap((message) =>
        message.parts.map((part, index) => ({
          id: part.id,
          ...(part.type === 'text' ? { role: message.role, text: part.text } : { part }),
          ...(message.role === 'assistant' && index === message.parts.length - 1 && message.modelRef
            ? { via: message.modelRef }
            : {}),
        })),
      ),
    );
    const usage = detail.session.agentEvents.findLast((event) => event.type === 'usage');
    setContextTokens(usage?.type === 'usage' ? (usage.inputTokens ?? null) : null);
    setReplyTokens(usage?.type === 'usage' ? (usage.outputTokens ?? null) : null);
    setAttachments([]);
    setOffset(0);
    closePanel();
    const pending = detail.messages
      .flatMap((message) => message.parts)
      .findLast((part) => part.type === 'approval_request' && part.state === 'pending');
    setApproval(pending?.type === 'approval_request' ? pending : null);
    const working =
      detail.session.status === 'running' || detail.session.status === 'awaiting_approval';
    setRunning(working);
    wasRunning.current = working;
    if (detail.session.status === 'interrupted') await client.sessions.resume(id);
  }
  async function openPanel(name: string) {
    const request = ++panelRequest.current;
    let options: PickerOption[] = [];
    if (name === '/model') options = await modelOptions(client);
    if (name === '/profile') options = profileOptions(await client.profiles.list());
    if (name === '/effort') {
      options = effortOptions(
        (await client.models.list()).find(
          (row) => row.ref === (model === 'auto' ? servedModel : model),
        ),
      );
      if (!options.length) {
        notice(
          'The active model does not support reasoning effort. Select a supported model with /model.',
        );
        return;
      }
    }
    if (name === '/project' || name === '/new')
      options = projectOptions(await client.workspaces.list());
    if (name === '/sessions') {
      const [sessions, projects] = await Promise.all([
        client.sessions.search(),
        client.workspaces.list(),
      ]);
      options = sessionOptions(sessions, projects);
    }
    if (panelRequest.current === request)
      setPanel({
        name,
        title: name === '/new' ? 'New chat / choose project' : name.slice(1),
        options,
      });
  }
  async function selectOption(value: string) {
    if (!panel) return;
    if (panel.name.startsWith('trust:')) {
      if (value === 'cancel') closePanel();
      else {
        const project = (await client.workspaces.list()).find((row) => row.id === value);
        if (project) await newChat(await client.workspaces.trust(project.id));
      }
      return;
    }
    if (panel.name === '/sessions') {
      await loadSession(value as SessionId);
      return;
    }
    if (panel.name === '/new' || panel.name === '/project') {
      await newChat((await client.workspaces.list()).find((row) => row.id === value) ?? null);
      return;
    }
    const id = await createSession();
    if (panel.name === '/model') {
      if (value === 'no-profile') {
        const profile = (await client.profiles.list()).find((row) => row.name === 'No profile');
        if (!profile) throw new Error('No profile option is unavailable.');
        await client.profiles.activate(profile.id, id);
        setActiveProfile(profile);
      } else {
        await client.models.select(id, value === 'auto' ? 'auto' : ModelRefSchema.parse(value));
        await client.sessions.setEffort(id, null);
        setModel(value);
        setServedModel(null);
        setEffort(null);
      }
    }
    if (panel.name === '/profile') {
      const profile = (await client.profiles.list()).find((row) => row.id === value);
      if (profile) {
        await client.profiles.activate(profile.id, id);
        setActiveProfile(profile);
      }
    }
    if (panel.name === '/effort') {
      await client.sessions.setEffort(id, (value || null) as Effort | null);
      setEffort((value || null) as Effort | null);
    }
    const selected = panel.options.find((row) => row.value === value);
    closePanel();
    if (selected)
      notice(
        `Selected ${selected.label}${panel.name === '/model' ? ` · Model set to ${value}` : ''}.`,
      );
  }
  async function submitText(text: string) {
    if (passwordEmail !== null) {
      await client.cloud.signIn({ email: passwordEmail, password: text });
      setCloudEmail(passwordEmail);
      setPasswordEmail(null);
      notice(good(`Signed in as ${passwordEmail}.`));
      return;
    }
    const parsed = parseSlashCommand(text);
    if (parsed.name === '/exit') {
      exit();
      return;
    }
    if (parsed.name === '/login') {
      const email = parsed.args.join(' ');
      if (!email) notice(warn('Usage: /login <email>'));
      else setPasswordEmail(email);
      return;
    }
    if (
      text.startsWith('/') &&
      !parsed.args.length &&
      ['/model', '/profile', '/effort', '/sessions', '/project', '/new'].includes(parsed.name)
    ) {
      await openPanel(parsed.name);
      return;
    }
    if (parsed.name === '/settings') {
      setSettingsOpen(true);
      return;
    }
    if (parsed.name === '/clear') {
      await newChat(project, false);
      return;
    }
    const id = await createSession();
    if (text.startsWith('/')) {
      if (parsed.name === '/compact') setReplyTokens(null);
      notice(
        await executeSlashCommand(
          {
            client,
            sessionId: id,
            cwd: project?.path ?? process.cwd(),
            onProfile: setActiveProfile,
            onModel: (value) => {
              setModel(value);
              setServedModel(null);
            },
            onCompact: notice,
            onClear: () => newChat(project),
            freeOnly,
            onFreeOnly: setFreeOnly,
          },
          text,
        ),
      );
      if (parsed.name === '/logout') setCloudEmail(null);
      return;
    }
    const paths = [...new Set([...attachments, ...fileMentions(text)])];
    if (paths.length && !project)
      throw new Error('Select a project with /project before attaching files.');
    const attached = project ? await readAttachments(project.path, paths) : [];
    setReplyTokens(null);
    setEntries((old) => [...old, { id: `pending-${String(Date.now())}`, role: 'user', text }]);
    setOffset(0);
    await client.sessions.send(id, { text, ...(attached.length ? { attachments: attached } : {}) });
    setAttachments([]);
  }
  return (
    <Box flexDirection="column" padding={1}>
      <Text>
        {gradient('Ferry')}{' '}
        {muted(
          `· ${engine === 'mock' ? 'mock engine' : 'real engine'}${cloudEmail ? ` · ${cloudEmail}` : ''}`,
        )}
      </Text>
      <Transcript
        entries={entries}
        offset={offset}
        enabled={!panel && !settingsOpen && !approval}
      />
      {approval ? <ApprovalPrompt summary={approval.summary} detail={approval.detail} /> : null}
      {running || busy ? (
        <Text>
          <Spinner type="dots" /> {muted('Working · Esc cancels')}
        </Text>
      ) : null}
      {panel ? (
        <Picker
          key={panel.name}
          title={panel.title}
          options={panel.options}
          onClose={closePanel}
          onSelect={(value) => {
            void selectOption(value).catch(showError);
          }}
          {...(panel.name === '/model' ? { freeOnly, onFreeOnly: setFreeOnly } : {})}
          {...(panel.name === '/sessions'
            ? {
                onQuery: (query: string) => {
                  const request = ++panelRequest.current;
                  void Promise.all([client.sessions.search({ query }), client.workspaces.list()])
                    .then(([sessions, workspaces]) => {
                      if (request === panelRequest.current)
                        setPanel((old) =>
                          old ? { ...old, options: sessionOptions(sessions, workspaces) } : null,
                        );
                    })
                    .catch(showError);
                },
              }
            : {})}
        />
      ) : settingsOpen ? (
        <SettingsPanel client={client} onClose={() => setSettingsOpen(false)} />
      ) : (
        <>
          {attachments.length ? <Text>{muted(`Attached: ${attachments.join(', ')}`)}</Text> : null}
          <Composer
            value={input}
            onChange={setInput}
            disabled={Boolean(approval) || busy || running}
            secret={passwordEmail !== null}
            files={files}
            onFile={(path) => setAttachments((old) => [...new Set([...old, path])])}
            onSubmit={(value) => {
              setInput('');
              setBusy(true);
              void submitText(value.trim())
                .catch(showError)
                .finally(() => setBusy(false));
            }}
          />
        </>
      )}
      <StatusBar
        project={project?.name}
        profile={activeProfile?.name ?? 'No profile'}
        model={servedModel ?? model}
        effort={effort}
        contextTokens={contextTokens}
        contextWindow={contextWindow}
        replyTokens={replyTokens}
        limits={limits}
        health={health}
      />
    </Box>
  );
}
export function ApprovalPrompt({ summary, detail }: { summary: string; detail: string }) {
  return (
    <Box flexDirection="column">
      <Text>{detail}</Text>
      <Text>{warn(`Approval: ${summary}  [y] allow  [n] deny  [a] always`)}</Text>
    </Box>
  );
}
