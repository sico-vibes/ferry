import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { FerryClient } from '@ferry/client';
import type { MessagePart, Profile, SessionId, Workspace } from '@ferry/shared';
import { blue, bad, good, muted, renderMarkdown, statusLine, warn } from './format.js';
import { executeSlashCommand, parseSlashCommand } from './slash.js';

/* Ink callbacks use void-returning event and timer APIs by design. */
/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/restrict-template-expressions */

export function Chat({
  client,
  workspace,
  profile,
  engine = 'local',
}: {
  client: FerryClient;
  workspace: Workspace;
  profile: Profile | undefined;
  engine?: 'local' | 'mock';
}) {
  const { exit } = useApp();
  const [session, setSession] = useState<SessionId | null>(null);
  const sessionRef = useRef<SessionId | null>(null);
  const sessionCreateRef = useRef<Promise<SessionId> | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<{
    id: import('@ferry/shared').PartId;
    summary: string;
    detail: string;
  } | null>(null);
  const [status, setStatus] = useState(`${profile?.name ?? 'No profile'} · auto`);
  const [activeProfile, setActiveProfile] = useState(profile);
  const [model, setModel] = useState('auto');
  const display = useRef({ profileName: activeProfile?.name ?? 'No profile', model });
  useEffect(() => {
    display.current = { profileName: activeProfile?.name ?? 'No profile', model };
  }, [activeProfile, model]);
  const [cloudEmail, setCloudEmail] = useState<string | null>(null);
  const [passwordEmail, setPasswordEmail] = useState<string | null>(null);
  const [freeOnly, setFreeOnly] = useState(false);
  const ctrlC = useRef(0);
  const ctrlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasRunning = useRef(false);
  const pressCtrlC = () => {
    ctrlC.current += 1;
    if (ctrlC.current >= 2) exit();
    if (ctrlTimer.current) clearTimeout(ctrlTimer.current);
    ctrlTimer.current = setTimeout(() => {
      ctrlC.current = 0;
    }, 1000);
  };
  const pressCtrlCRef = useRef(pressCtrlC);
  pressCtrlCRef.current = pressCtrlC;
  useEffect(() => {
    // In a Windows console, Ctrl+C arrives as a signal (it would kill the process on the first press)
    // rather than as a key, so count it the same way: the second press within a second exits.
    const onSigint = () => {
      pressCtrlCRef.current();
    };
    process.on('SIGINT', onSigint);
    return () => {
      process.off('SIGINT', onSigint);
    };
  }, []);
  useEffect(() => {
    let active = true;
    void client.quota
      .limits()
      .then((quota) => {
        if (active) setStatus(statusLine(activeProfile?.name ?? 'No profile', model, quota));
      })
      .catch(showError);
    void client.cloud
      .status()
      .then((cloud) => {
        if (active) setCloudEmail(cloud.auth.signedIn ? cloud.auth.email : null);
      })
      .catch(showError);
    const off = client.on('session.delta', ({ sessionId, textDelta }) => {
      if (sessionId !== sessionRef.current) return;
      setLines((old) => {
        const next = [...old];
        if (next.at(-1)?.startsWith('assistant: '))
          next[next.length - 1] = `assistant: ${next.at(-1)?.slice(11) ?? ''}${textDelta}`;
        else next.push(`assistant: ${textDelta}`);
        return next;
      });
    });
    const partOff = client.on('session.part', ({ sessionId, part }) => {
      if (sessionId !== sessionRef.current) return;
      setLines((old) => [...old, describePart(part)]);
      if (part.type === 'approval_request' && part.state === 'pending')
        setApproval({ id: part.id, summary: part.summary, detail: part.detail });
    });
    const updateOff = client.on('session.updated', (value) => {
      if (value.id !== sessionRef.current) return;
      if (value.modelRef) {
        display.current.model = value.modelRef;
        setModel(value.modelRef);
        void client.quota
          .limits()
          .then((limits) =>
            setStatus(statusLine(display.current.profileName, display.current.model, limits)),
          )
          .catch(showError);
      }
      const nowRunning = value.status === 'running' || value.status === 'awaiting_approval';
      setRunning(nowRunning);
      if (wasRunning.current && !nowRunning) {
        void client.sessions
          .get(value.id)
          .then(({ messages }) => {
            const answer = messages.findLast((message) => message.role === 'assistant');
            const modelRef = answer?.modelRef;
            if (modelRef) setLines((old) => [...old, muted(`via ${modelRef}`)]);
          })
          .catch(showError);
      }
      wasRunning.current = nowRunning;
    });
    const limitsOff = client.on('quota.limits.updated', (limits) => {
      setStatus(statusLine(display.current.profileName, display.current.model, limits));
    });
    return () => {
      active = false;
      off();
      partOff();
      updateOff();
      limitsOff();
    };
  }, [client, profile, workspace]);
  useInput((value, key) => {
    // CONIN$ can report Enter as a literal CR/LF pair instead of Ink's normalized return key.
    // Handle the byte forms here as well, and let this handler own submission so the input is
    // submitted exactly once regardless of how the terminal reports Enter.
    if (key.return || value === '\r' || value === '\n') {
      submit(input);
      return;
    }
    if (key.escape && session && running) void client.sessions.cancel(session).catch(showError);
    if (key.ctrl && value === 'c') pressCtrlC();
    if (approval && ['y', 'n', 'a'].includes(value.toLowerCase())) {
      const decision =
        value.toLowerCase() === 'n'
          ? 'deny'
          : value.toLowerCase() === 'a'
            ? 'allow_always'
            : 'allow_once';
      if (session) void client.approvals.respond(session, approval.id, decision).catch(showError);
      setApproval(null);
    }
  });
  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    setInput('');
    void submitText(text).catch(showError);
  };

  async function submitText(text: string): Promise<void> {
    const currentSession = sessionRef.current ?? (await createSession());
    if (passwordEmail !== null) {
      setPasswordEmail(null);
      await client.cloud.signIn({ email: passwordEmail, password: text });
      setCloudEmail(passwordEmail);
      setLines((old) => [...old, good(`Signed in as ${passwordEmail}.`)]);
      return;
    }
    const parsed = parseSlashCommand(text);
    if (parsed.name === '/exit') {
      exit();
      return;
    }
    if (parsed.name === '/login') {
      const email = parsed.args.join(' ');
      if (!email) {
        setLines((old) => [...old, warn('Usage: /login <email>')]);
        return;
      }
      setPasswordEmail(email);
      return;
    }
    if (text.startsWith('/')) {
      setLines((old) => [...old, blue(text)]);
      const result = await executeSlashCommand(
        {
          client,
          sessionId: currentSession,
          cwd: process.cwd(),
          onProfile: (next) => {
            setActiveProfile(next);
            void client.quota
              .limits()
              .then((quota) => setStatus(statusLine(next.name, model, quota)))
              .catch(showError);
          },
          onModel: (ref) => {
            setModel(ref);
            void client.quota
              .limits()
              .then((quota) =>
                setStatus(statusLine(activeProfile?.name ?? 'No profile', ref, quota)),
              )
              .catch(showError);
          },
          onCompact: (summary) => setLines([muted(summary)]),
          onClear: async () => {
            const next = await client.sessions.create({
              workspaceId: workspace.id,
              ...(activeProfile ? { profileId: activeProfile.id } : {}),
              title: 'New Chat',
            });
            setSession(next.id);
            sessionRef.current = next.id;
            sessionCreateRef.current = null;
            setLines([]);
          },
          freeOnly,
          onFreeOnly: setFreeOnly,
        },
        text,
      );
      setLines((old) => [...old, result]);
      if (parsed.name === '/logout') setCloudEmail(null);
      return;
    }
    setLines((old) => [...old, `you: ${text}`]);
    await client.sessions.send(currentSession, { text });
  }

  function createSession(): Promise<SessionId> {
    if (sessionCreateRef.current) return sessionCreateRef.current;
    const creation = client.sessions
      .create({
        workspaceId: workspace.id,
        ...(activeProfile ? { profileId: activeProfile.id } : {}),
        title: 'New Chat',
      })
      .then(({ id }) => {
        sessionRef.current = id;
        setSession(id);
        return id;
      })
      .catch((error: unknown) => {
        sessionCreateRef.current = null;
        throw error;
      });
    sessionCreateRef.current = creation;
    return creation;
  }

  function showError(error: unknown) {
    setLines((old) => [...old, bad(error instanceof Error ? error.message : String(error))]);
  }
  return (
    <Box flexDirection="column" padding={1}>
      <Text>
        {blue('Ferry')}{' '}
        {muted(
          `· ${engine === 'mock' ? 'mock engine' : 'real engine'} · ${activeProfile?.name ?? 'No profile'} · ${model === 'auto' ? 'Auto' : model} · ${workspace.name}${cloudEmail ? ` · ${cloudEmail}` : ''}`,
        )}
      </Text>
      <Text>{status}</Text>
      <Box flexDirection="column" marginY={1}>
        {lines.slice(-18).map((line, i) => (
          <Text key={`${i}-${line}`}>
            {line.startsWith('assistant: ') ? renderMarkdown(line.slice(11)) : line}
          </Text>
        ))}
      </Box>
      {approval ? (
        <Box flexDirection="column">
          <Text>{approval.detail}</Text>
          <Text>{warn(`Approval: ${approval.summary}  [y] allow  [n] deny  [a] always`)}</Text>
        </Box>
      ) : null}
      {running ? (
        <Text>
          <Spinner type="dots" /> {muted('Working · Esc cancels')}
        </Text>
      ) : null}
      <Box>
        <Text>{blue('› ')}</Text>
        {passwordEmail !== null ? (
          <TextInput value={input} onChange={updateInput} mask="•" />
        ) : (
          <TextInput value={input} onChange={updateInput} />
        )}
      </Box>
    </Box>
  );

  function updateInput(value: string) {
    if (!/[\r\n]/.test(value)) {
      setInput(value);
      return;
    }
    // A chunk that ends in Enter ("hello\r", a paste, or a fast terminal) arrives as one value, and
    // Ink does not report it as a return key. Submit the text before the line break. A lone Enter
    // (value = input + newline) adds no text and is submitted by the useInput handler instead, so
    // nothing is sent twice.
    const text = value.replace(/[\r\n]+/g, ' ').trim();
    if (text && text !== input.trim()) submit(text);
  }
}

export function ApprovalPrompt({ summary, detail }: { summary: string; detail: string }) {
  return (
    <Box flexDirection="column">
      <Text>{detail}</Text>
      <Text>{warn(`Approval: ${summary}  [y] allow  [n] deny  [a] always`)}</Text>
    </Box>
  );
}

function describePart(part: MessagePart): string {
  if (part.type === 'tool_call')
    return `${part.status === 'succeeded' ? good('✓') : part.status === 'failed' ? bad('✗') : blue('◌')} ${part.title}`;
  if (part.type === 'handoff_marker')
    return muted(`↪ Handoff ${part.from} → ${part.to}: ${part.explanation}`);
  if (part.type === 'checkpoint') return good(`◆ Checkpoint: ${part.label}`);
  if (part.type === 'delegation') return blue(`▣ Delegation run ${part.runId}`);
  if (part.type === 'error') return bad(`Error: ${part.message}`);
  if (part.type === 'approval_request') return warn(`Approval requested: ${part.summary}`);
  return '';
}
