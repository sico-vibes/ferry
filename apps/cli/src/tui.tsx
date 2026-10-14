import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { FerryClient } from '@ferry/client';
import { ModelRefSchema, redactKnownSecretText } from '@ferry/shared';
import type {
  CliBilling,
  CliConnection,
  CliConnectionKind,
  CliConnectionSettings,
  CliModelCapabilities,
  CliOption,
  CliSpeed,
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
import { controlCPresses } from './interrupt.js';
import { Picker, type PickerFilterMode, type PickerOption } from './components/picker.js';
import { Composer } from './components/composer.js';
import { SettingsPanel } from './components/settings-panel.js';
import { ConnectPanel } from './components/connect-panel.js';
import { CliOptionsPanel } from './components/cli-options-panel.js';
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
import {
  cliBrandName,
  cliEffortOptionRows,
  cliModelSelectability,
  cliSpeedOptionRows,
  connectionOptionLayer,
  decodeCliModelValue,
  findCliModel,
  findConnection,
  isCliConnectionKind,
  mergeCliOptionDraft,
  resolveCliModelStatus,
  resolveCliOptions,
  type CliOptionLayers,
} from './cli-connections.js';

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
  const [connectOpen, setConnectOpen] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [modelFilter, setModelFilter] = useState<PickerFilterMode>('all');
  const [cliInventory, setCliInventory] = useState<CliConnection[]>([]);
  const [optionsPanel, setOptionsPanel] = useState<{
    connection: CliConnection;
    model: CliModelCapabilities;
    options: CliOption;
  } | null>(null);
  const cliOptionsDraft = useRef<{ modelRef: string; options: Partial<CliOption> } | null>(null);
  const cliOptionOverrides = useRef<Record<string, Partial<CliOption>>>({});
  const cliOptionRequest = useRef(0);
  const [cliSettings, setCliSettings] = useState<Record<string, CliConnectionSettings>>({});
  const [cliBilling, setCliBilling] = useState<CliBilling | null>(null);
  const [cliSpeed, setCliSpeed] = useState<CliSpeed | null>(null);
  const [cliEffort, setCliEffort] = useState<string | null>(null);
  const [cliModelRef, setCliModelRef] = useState<string | null>(null);
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
    if (ctrlC.current >= 2) {
      if (ctrlTimer.current) clearTimeout(ctrlTimer.current);
      exit();
      return;
    }
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
    void Promise.all([
      client.quota.limits(),
      client.providers.health(),
      client.cloud.status(),
      client.settings.get(),
    ])
      .then(([quota, providers, cloud, settings]) => {
        if (!active) return;
        setLimits(quota);
        setHealth(providers);
        setCloudEmail(cloud.auth.signedIn ? cloud.auth.email : null);
        setCliSettings(settings.cliConnections);
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
    // Refresh the CLI inventory only while the model/options panels are visible. The chat screen
    // never starts discovery on load and never polls while hidden.
    if (panel?.name !== '/model' && !optionsPanel) return;
    const off = client.on('cliConnections.updated', (connection) => {
      setCliInventory((old) => [...old.filter((row) => row.kind !== connection.kind), connection]);
      if (panel?.name === '/model') {
        void modelOptions(client)
          .then((options) =>
            setPanel((old) => (old?.name === '/model' ? { ...old, options } : old)),
          )
          .catch(showError);
      }
    });
    return off;
  }, [client, panel, optionsPanel]);
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
    const interrupts = controlCPresses(value, key.ctrl);
    if (interrupts) {
      for (let index = 0; index < interrupts; index++) pressCtrlC();
      return;
    }
    if (panel || settingsOpen || connectOpen || optionsPanel) return;
    if (key.escape && running && sessionRef.current)
      void client.sessions.cancel(sessionRef.current).catch(showError);
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
        const draft = cliOptionsDraft.current;
        if (draft) {
          await client.sessions.updateCliOptions(next.id, {
            modelRef: ModelRefSchema.parse(draft.modelRef),
            options: draft.options,
          });
          cliOptionOverrides.current[draft.modelRef] = {
            ...(cliOptionOverrides.current[draft.modelRef] ?? {}),
            ...draft.options,
          };
          cliOptionsDraft.current = null;
        }
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
    cliOptionsDraft.current = null;
    cliOptionOverrides.current = {};
    setProject(nextProject);
    setEntries([]);
    setModel('auto');
    setServedModel(null);
    setEffort(null);
    setCliBilling(null);
    setCliSpeed(null);
    setCliEffort(null);
    setCliModelRef(null);
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
    const [projects, profiles, connections, settings] = await Promise.all([
      client.workspaces.list(),
      client.profiles.list(),
      client.cliConnections.list(),
      client.settings.get(),
    ]);
    sessionRef.current = id;
    creation.current = null;
    cliOptionsDraft.current = null;
    cliOptionOverrides.current = { ...(detail.session.cliOptions ?? {}) };
    setCliInventory(connections);
    setCliSettings(settings.cliConnections);
    setProject(projects.find((row) => row.id === detail.session.workspaceId) ?? null);
    const profile = profiles.find((row) => row.id === detail.session.profileId);
    setActiveProfile(profile);
    const requested = detail.session.pinnedModelRef ?? 'auto';
    setModel(requested);
    setServedModel(detail.session.modelRef);
    setEffort(detail.session.effort ?? null);
    const activeRef = requested === 'auto' ? detail.session.modelRef : requested;
    const status = resolveCliModelStatus(
      activeRef,
      connections,
      settings.cliConnections,
      profile,
      activeRef ? cliOptionOverrides.current[activeRef] : undefined,
    );
    setCliModelRef(status?.ref ?? null);
    setCliBilling(status?.billing ?? null);
    setCliEffort(status?.effort ?? null);
    setCliSpeed(status?.speed ?? null);
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
    if (name === '/model') {
      options = await modelOptions(client);
      setCliInventory(await client.cliConnections.list());
    }
    if (name === '/profile') options = profileOptions(await client.profiles.list());
    if (name === '/effort') {
      const activeRef = model === 'auto' ? servedModel : model;
      const connection = activeRef
        ? findConnection(cliInventory, activeRef.split('/')[0] as CliConnectionKind)
        : undefined;
      const cliModel = findCliModel(connection, activeRef ?? '');
      if (connection && cliModel) {
        options = cliEffortOptionRows(cliModel);
      } else {
        options = effortOptions((await client.models.list()).find((row) => row.ref === activeRef));
      }
      if (!options.length) {
        notice(
          'The active model does not support reasoning effort. Select a supported model with /model.',
        );
        return;
      }
    }
    if (name === '/project' || name === '/new')
      options = projectOptions(await client.workspaces.list());
    if (name === '/speed') {
      const active = activeCli();
      options = active ? cliSpeedOptionRows(active.model) : [];
      if (!options.length) {
        notice(
          'Speed applies to opted-in native CLI models that advertise fast mode. Select one with /model.',
        );
        return;
      }
    }
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
  function activeCli(): {
    connection: CliConnection;
    model: CliModelCapabilities;
    ref: string;
  } | null {
    const activeRef = model === 'auto' ? servedModel : model;
    if (!activeRef) return null;
    const kind = activeRef.split('/')[0];
    if (!kind || !isCliConnectionKind(kind)) return null;
    const connection = findConnection(cliInventory, kind);
    const cliModel = findCliModel(connection, activeRef);
    return connection && cliModel ? { connection, model: cliModel, ref: activeRef } : null;
  }
  function cliLayersFor(ref: string): CliOptionLayers {
    const kind = ref.split('/')[0];
    const saved = kind && isCliConnectionKind(kind) ? cliSettings[kind] : undefined;
    const refKey = ref as CliModelCapabilities['ref'];
    return {
      conversation: cliOptionOverrides.current[ref],
      profile: activeProfile?.cliDefaults?.[refKey],
      connection: connectionOptionLayer(saved, refKey),
    };
  }
  async function persistCliOptions(ref: string, patch: Partial<CliOption>) {
    if (sessionRef.current) {
      await client.sessions.updateCliOptions(sessionRef.current, {
        modelRef: ModelRefSchema.parse(ref),
        options: patch,
      });
    } else {
      cliOptionsDraft.current = mergeCliOptionDraft(cliOptionsDraft.current, ref, patch);
    }
    cliOptionOverrides.current[ref] = { ...(cliOptionOverrides.current[ref] ?? {}), ...patch };
  }
  async function applyEffort(token: string) {
    const active = activeCli();
    if (active) {
      const choice = cliEffortOptionRows(active.model).find((row) => row.value === token);
      if (!choice) {
        notice(`Unknown effort ${token} for ${active.model.name}.`);
        return;
      }
      if (choice.disabled) {
        notice(
          `${token} is unavailable for ${active.model.name}: ${choice.reason ?? 'not supported'}`,
        );
        return;
      }
      await createSession();
      await persistCliOptions(active.ref, { effort: token === '' ? null : token });
      setCliEffort(token === '' ? null : token);
      notice(`Effort set to ${token || 'Default'} for ${active.model.name}.`);
      return;
    }
    if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(token)) {
      notice(`Unknown effort ${token}. Use /model to choose a model with reasoning effort.`);
      return;
    }
    const id = await createSession();
    await client.sessions.setEffort(id, token as Effort);
    setEffort(token as Effort);
    notice(`Effort set to ${token}.`);
  }
  async function applySpeed(value: string) {
    if (value !== 'standard' && value !== 'fast') {
      notice('Usage: /speed standard|fast');
      return;
    }
    const active = activeCli();
    if (!active) {
      notice('Speed applies to opted-in native CLI models only.');
      return;
    }
    if (value === 'fast' && !active.model.speeds.includes('fast')) {
      notice(`Fast is not advertised by ${active.model.name}.`);
      return;
    }
    await createSession();
    await persistCliOptions(active.ref, { speed: value });
    setCliSpeed(value);
    notice(
      value === 'fast'
        ? 'Fast requested. Additional charges need spending approval; Ferry did not pre-authorize spending.'
        : 'Speed set to Standard.',
    );
  }
  function openCliOptions(connection: CliConnection, cliModel: CliModelCapabilities, ref: string) {
    // Reopening the current model keeps its compatible conversation/profile/connection choices;
    // switching models resolves fresh against the new model's reported effort and standard speed.
    const resolved = resolveCliOptions(cliModel, cliLayersFor(ref));
    setModel(ref);
    setServedModel(null);
    setEffort(null);
    setCliBilling(cliModel.billing);
    setCliSpeed(resolved.speed);
    setCliEffort(resolved.effort);
    setCliModelRef(ref);
    closePanel();
    setOptionsPanel({ connection, model: cliModel, options: resolved });
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
      const decoded = decodeCliModelValue(value);
      if (decoded) {
        const connection = findConnection(cliInventory, decoded.kind);
        const cliModel = findCliModel(connection, decoded.ref);
        if (!connection || !cliModel) {
          closePanel();
          notice('That CLI model is no longer available. Reopen /model or refresh /connect.');
          return;
        }
        const selectability = cliModelSelectability(connection, cliModel);
        if (!selectability.selectable) {
          closePanel();
          notice(selectability.reason ?? 'This CLI model is not selectable yet.');
          return;
        }
        try {
          await client.models.select(id, ModelRefSchema.parse(cliModel.ref));
        } catch (error) {
          // Leave the previous model, status, and options untouched and surface the real, redacted
          // provider error with the next action instead of continuing as if the switch succeeded.
          closePanel();
          const detail = redactKnownSecretText(
            error instanceof Error ? error.message : String(error),
          );
          notice(
            bad(
              `Could not select ${cliModel.name}: ${detail} Refresh or verify ${cliBrandName(connection.kind)} in /connect, then try again.`,
            ),
          );
          return;
        }
        openCliOptions(connection, cliModel, cliModel.ref);
        notice(`Selected ${cliModel.name} · configure its options.`);
        return;
      }
      cliOptionsDraft.current = null;
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
        setCliBilling(null);
        setCliSpeed(null);
        setCliEffort(null);
        setCliModelRef(null);
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
      const active = activeCli();
      if (active) {
        await persistCliOptions(active.ref, { effort: value === '' ? null : value });
        setCliEffort(value === '' ? null : value);
      } else {
        await client.sessions.setEffort(id, (value || null) as Effort | null);
        setEffort((value || null) as Effort | null);
      }
    }
    if (panel.name === '/speed') {
      const active = activeCli();
      if (active) {
        await persistCliOptions(active.ref, { speed: value === 'fast' ? 'fast' : 'standard' });
        setCliSpeed(value === 'fast' ? 'fast' : 'standard');
      }
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
    if (parsed.name === '/connect' && !parsed.args.length) {
      setConnectOpen(true);
      return;
    }
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
    if (parsed.name === '/effort' && parsed.args.length) {
      await applyEffort(parsed.args[0] ?? '');
      return;
    }
    if (parsed.name === '/speed' && parsed.args.length) {
      await applySpeed(parsed.args[0] ?? '');
      return;
    }
    if (
      text.startsWith('/') &&
      !parsed.args.length &&
      ['/model', '/profile', '/effort', '/speed', '/sessions', '/project', '/new'].includes(
        parsed.name,
      )
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
    const id = [
      '/connect',
      '/gateway',
      '/doctor',
      '/help',
      '/quota',
      '/status',
      '/optimize',
    ].includes(parsed.name)
      ? (sessionRef.current ?? ('command_only' as SessionId))
      : await createSession();
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
            onFreeOnly: (value) => {
              setFreeOnly(value);
              setModelFilter(value ? 'free' : 'all');
            },
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
        enabled={!panel && !settingsOpen && !connectOpen && !optionsPanel && !approval}
      />
      {approval ? <ApprovalPrompt summary={approval.summary} detail={approval.detail} /> : null}
      {running || busy ? (
        <Text>
          <Spinner type="dots" /> {muted('Working · Esc cancels')}
        </Text>
      ) : null}
      {connectOpen ? (
        <ConnectPanel client={client} onClose={() => setConnectOpen(false)} />
      ) : optionsPanel ? (
        <CliOptionsPanel
          model={optionsPanel.model}
          options={optionsPanel.options}
          onClose={() => setOptionsPanel(null)}
          onChange={async (patch) => {
            const request = ++cliOptionRequest.current;
            try {
              await persistCliOptions(optionsPanel.model.ref, patch);
            } catch (error) {
              // Only the latest request owns the panel message; a stale failure is dropped so it
              // cannot overwrite a newer confirmed change.
              if (request === cliOptionRequest.current) throw error;
              return;
            }
            if (request !== cliOptionRequest.current) return;
            setOptionsPanel((prev) =>
              prev ? { ...prev, options: { ...prev.options, ...patch } } : prev,
            );
            if (patch.effort !== undefined) setCliEffort(patch.effort);
            if (patch.speed !== undefined) setCliSpeed(patch.speed);
          }}
        />
      ) : panel ? (
        <Picker
          key={panel.name}
          title={panel.title}
          options={panel.options}
          onClose={closePanel}
          onSelect={(value) => {
            void selectOption(value).catch(showError);
          }}
          {...(panel.name === '/model'
            ? { filter: { mode: modelFilter, onChange: setModelFilter } }
            : {})}
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
        requestedModel={model}
        paidAllowed={activeProfile?.paidAllowed ?? false}
        effort={cliModelRef ? cliEffort : effort}
        cliBilling={cliBilling}
        cliSpeed={cliSpeed}
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
