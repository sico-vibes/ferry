import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { FerryClient } from '@ferry/client';
import type { MessagePart, Profile, SessionId, Workspace } from '@ferry/shared';
import { blue, bad, good, muted, renderMarkdown, statusLine, warn } from './format.js';
import { executeSlashCommand } from './slash.js';

/* Ink callbacks use void-returning event and timer APIs by design. */
/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/restrict-template-expressions */

export function Chat({
  client,
  workspace,
  profile,
}: {
  client: FerryClient;
  workspace: Workspace;
  profile: Profile;
}) {
  const { exit } = useApp();
  const [session, setSession] = useState<SessionId | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<{
    id: import('@ferry/shared').PartId;
    summary: string;
  } | null>(null);
  const [status, setStatus] = useState(`${profile.name} · auto · loading capacity`);
  const [activeProfile, setActiveProfile] = useState(profile);
  const [model, setModel] = useState('auto');
  const ctrlC = useRef(0);
  const ctrlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let active = true;
    void client.quota.capacity().then((quota) => {
      if (active) setStatus(statusLine(activeProfile.name, model, quota));
    });
    void client.sessions
      .create({ workspaceId: workspace.id, profileId: profile.id, title: 'New Chat' })
      .then((value) => {
        if (active) setSession(value.id);
      });
    const off = client.on('session.delta', ({ textDelta }) =>
      setLines((old) => {
        const next = [...old];
        if (next.at(-1)?.startsWith('assistant: '))
          next[next.length - 1] = `assistant: ${next.at(-1)?.slice(11) ?? ''}${textDelta}`;
        else next.push(`assistant: ${textDelta}`);
        return next;
      }),
    );
    const partOff = client.on('session.part', ({ part }) => {
      setLines((old) => [...old, describePart(part)]);
      if (part.type === 'approval_request' && part.state === 'pending')
        setApproval({ id: part.id, summary: part.summary });
    });
    const updateOff = client.on('session.updated', (value) =>
      setRunning(value.status === 'running' || value.status === 'awaiting_approval'),
    );
    return () => {
      active = false;
      off();
      partOff();
      updateOff();
    };
  }, [client, profile, workspace]);
  useInput((value, key) => {
    if (key.escape && session && running) void client.sessions.cancel(session);
    if (key.ctrl && value === 'c') {
      ctrlC.current += 1;
      if (ctrlC.current >= 2) exit();
      if (ctrlTimer.current) clearTimeout(ctrlTimer.current);
      ctrlTimer.current = setTimeout(() => {
        ctrlC.current = 0;
      }, 1000);
    }
    if (approval && ['y', 'n', 'a'].includes(value.toLowerCase())) {
      const decision =
        value.toLowerCase() === 'n'
          ? 'deny'
          : value.toLowerCase() === 'a'
            ? 'allow_always'
            : 'allow_once';
      if (session) void client.approvals.respond(session, approval.id, decision);
      setApproval(null);
    }
  });
  const submit = (value: string) => {
    const text = value.trim();
    if (!text || !session) return;
    setInput('');
    if (text.startsWith('/')) {
      setLines((old) => [...old, blue(text)]);
      void executeSlashCommand(
        {
          client,
          sessionId: session,
          cwd: process.cwd(),
          onProfile: (next) => {
            setActiveProfile(next);
            void client.quota
              .capacity()
              .then((quota) => setStatus(statusLine(next.name, model, quota)));
          },
          onModel: (ref) => {
            setModel(ref);
            void client.quota
              .capacity()
              .then((quota) => setStatus(statusLine(activeProfile.name, ref, quota)));
          },
          onCompact: (summary) => setLines([muted(summary)]),
          onClear: async () => {
            const next = await client.sessions.create({
              workspaceId: workspace.id,
              profileId: activeProfile.id,
              title: 'New Chat',
            });
            setSession(next.id);
            setLines([]);
          },
        },
        text,
      )
        .then((result) => setLines((old) => [...old, result]))
        .catch((error: unknown) =>
          setLines((old) => [...old, bad(error instanceof Error ? error.message : String(error))]),
        );
      return;
    }
    setLines((old) => [...old, `you: ${text}`]);
    void client.sessions.send(session, { text });
  };
  return (
    <Box flexDirection="column" padding={1}>
      <Text>
        {blue('Ferry')} {muted('· local mock engine')}
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
        <Text>{warn(`Approval: ${approval.summary}  [y] allow  [n] deny  [a] always`)}</Text>
      ) : null}
      {running ? (
        <Text>
          <Spinner type="dots" /> {muted('Working · Esc cancels')}
        </Text>
      ) : null}
      <Box>
        <Text>{blue('› ')}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} />
      </Box>
    </Box>
  );
}

export function ApprovalPrompt({ summary }: { summary: string }) {
  return <Text>{warn(`Approval: ${summary}  [y] allow  [n] deny  [a] always`)}</Text>;
}

function describePart(part: MessagePart): string {
  if (part.type === 'tool_call')
    return `${part.status === 'succeeded' ? good('✓') : part.status === 'failed' ? bad('✗') : blue('◌')} ${part.title}${part.output ? ` ${muted(`[${part.output.filtered ? 'filtered' : 'output'}] ${part.output.text}`)}` : ''}`;
  if (part.type === 'handoff_marker')
    return muted(`↪ Handoff ${part.from} → ${part.to}: ${part.explanation}`);
  if (part.type === 'checkpoint') return good(`◆ Checkpoint: ${part.label}`);
  if (part.type === 'delegation') return blue(`▣ Delegation run ${part.runId}`);
  if (part.type === 'error') return bad(`Error: ${part.message}`);
  if (part.type === 'approval_request') return warn(`Approval requested: ${part.summary}`);
  return '';
}
