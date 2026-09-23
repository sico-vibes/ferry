/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import { MessageSchema, TaskRecordSchema } from '@ferry/shared';
import { createFakeClock } from '../src/mock/clock.js';
import { createMockFerryClient } from '../src/mock/client.js';
import { createPlaybackRunner } from '../src/mock/playback/engine.js';
import { runFerryClientContract } from '../src/testing/contract.js';

function setup(speed = 0) {
  const fake = createFakeClock(new Date('2026-09-23T12:00:00.000Z'));
  const client = createMockFerryClient({
    clock: fake.clock,
    scenarioRunner: createPlaybackRunner({ speed }),
  });
  const events: string[] = [];
  for (const event of [
    'session.message',
    'session.part',
    'session.delta',
    'session.updated',
    'task.updated',
    'quota.updated',
    'toast',
    'delegation.updated',
  ] as const)
    client.on(event, () => events.push(event));
  return { client, fake, events };
}

async function flush(fake: ReturnType<typeof createFakeClock>, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    fake.advance(100_000);
    await Promise.resolve();
    await Promise.resolve();
  }
}

async function waitFor(fake: ReturnType<typeof createFakeClock>, check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    await flush(fake, 1);
    if (check()) return;
  }
  throw new Error('Playback did not reach the expected state');
}

describe('scripted playback', () => {
  it('plays fix-tests, waits for approval, updates task and capacity, then completes', async () => {
    const { client, fake, events } = setup();
    await client.sessions.send('session_3' as never, { text: 'Fix the flaky payment tests' });
    await waitFor(
      fake,
      () =>
        client.__state().sessions.find((session) => session.id === 'session_3')?.status ===
        'awaiting_approval',
    );
    const detail = await client.sessions.get('session_3' as never);
    const approval = detail.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'approval_request' && part.state === 'pending');
    expect(approval?.type).toBe('approval_request');
    if (approval?.type !== 'approval_request') throw new Error('Approval part missing');
    expect(events).toContain('session.delta');
    await client.approvals.respond('session_3' as never, approval.id, 'allow_once');
    await waitFor(
      fake,
      () =>
        client.__state().sessions.find((session) => session.id === 'session_3')?.status === 'idle',
    );
    const final = await client.sessions.get('session_3' as never);
    for (const message of final.messages) MessageSchema.parse(message);
    TaskRecordSchema.parse(final.taskRecord);
    expect(
      final.taskRecord.touchedFiles.some((file) => file.path === 'src/payments/retry.ts'),
    ).toBe(true);
    expect(
      final.messages.flatMap((message) => message.parts).some((part) => part.type === 'checkpoint'),
    ).toBe(true);
    expect(events).toContain('session.delta');
    expect(
      client.__state().providers.find((provider) => provider.id === 'gemini')?.stepsLeftToday,
    ).toBeLessThan(38);
  });

  it('marks the gated test tool denied and continues with the denial copy', async () => {
    const { client, fake } = setup();
    await client.sessions.send('session_3' as never, { text: 'Fix failing tests' });
    await waitFor(
      fake,
      () =>
        client.__state().sessions.find((session) => session.id === 'session_3')?.status ===
        'awaiting_approval',
    );
    const approval = (await client.sessions.get('session_3' as never)).messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'approval_request' && part.state === 'pending');
    if (approval?.type !== 'approval_request') throw new Error('Approval part missing');
    await client.approvals.respond('session_3' as never, approval.id, 'deny');
    await waitFor(
      fake,
      () =>
        client.__state().sessions.find((session) => session.id === 'session_3')?.status === 'idle',
    );
    const parts = (await client.sessions.get('session_3' as never)).messages.flatMap(
      (message) => message.parts,
    );
    expect(parts.some((part) => part.type === 'tool_call' && part.status === 'denied')).toBe(true);
    expect(
      parts.some((part) => part.type === 'text' && part.text.includes("I won't run the tests")),
    ).toBe(true);
  });

  it('waits for delegation completion before continuing', async () => {
    const { client, fake } = setup();
    await client.sessions.send('session_3' as never, { text: 'Delegate this refactor to Codex' });
    await waitFor(
      fake,
      () =>
        client.__state().sessions.find((session) => session.id === 'session_3')?.status ===
        'awaiting_approval',
    );
    const approval = (await client.sessions.get('session_3' as never)).messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'approval_request' && part.state === 'pending');
    if (approval?.type !== 'approval_request') throw new Error('Delegation approval missing');
    await client.approvals.respond('session_3' as never, approval.id, 'allow_once');
    await waitFor(
      fake,
      () =>
        client.__state().sessions.find((session) => session.id === 'session_3')?.status === 'idle',
    );
    expect(client.__state().delegationRuns[0]?.status).toBe('completed');
    const text = (await client.sessions.get('session_3' as never)).messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
    expect(text).toContain('Gates re-run');
  });

  it('auto-hands off when the current free provider reaches zero', async () => {
    const { client, fake } = setup();
    const gemini = client.__state().providers.find((provider) => provider.id === 'gemini');
    if (gemini) gemini.stepsLeftToday = 1;
    await client.sessions.send('session_3' as never, { text: 'Explain the architecture' });
    await waitFor(
      fake,
      () =>
        client.__state().sessions.find((session) => session.id === 'session_3')?.status === 'idle',
    );
    const parts = (await client.sessions.get('session_3' as never)).messages.flatMap(
      (message) => message.parts,
    );
    expect(parts.some((part) => part.type === 'handoff_marker' && part.reason === 'quota')).toBe(
      true,
    );
  });

  it('plays the explicit model handoff scenario', async () => {
    const { client, fake } = setup();
    await client.sessions.send('session_3' as never, { text: 'Continue after quota handoff' });
    await waitFor(
      fake,
      () =>
        client.__state().sessions.find((session) => session.id === 'session_3')?.status === 'idle',
    );
    const parts = (await client.sessions.get('session_3' as never)).messages.flatMap(
      (message) => message.parts,
    );
    expect(
      parts.some(
        (part) =>
          part.type === 'handoff_marker' &&
          part.from === 'cerebras/gpt-oss-120b' &&
          part.to === 'nvidia/nemotron-3-ultra',
      ),
    ).toBe(true);
  });

  it('supports both paid capacity approval decisions', async () => {
    for (const decision of ['allow_once', 'deny'] as const) {
      const { client, fake } = setup();
      await client.sessions.send('session_3' as never, { text: 'We are out of capacity' });
      await waitFor(
        fake,
        () =>
          client.__state().sessions.find((session) => session.id === 'session_3')?.status ===
          'awaiting_approval',
      );
      const approval = (await client.sessions.get('session_3' as never)).messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'approval_request' && part.state === 'pending');
      if (approval?.type !== 'approval_request') throw new Error('Paid model approval missing');
      await client.approvals.respond('session_3' as never, approval.id, decision);
      await waitFor(
        fake,
        () =>
          client.__state().sessions.find((session) => session.id === 'session_3')?.status ===
          'idle',
      );
      const parts = (await client.sessions.get('session_3' as never)).messages.flatMap(
        (message) => message.parts,
      );
      expect(
        parts.some((part) => part.type === 'handoff_marker' && part.to === 'opencode-go/glm-5.3'),
      ).toBe(decision === 'allow_once');
      if (decision === 'deny')
        expect(
          parts.some(
            (part) => part.type === 'text' && part.text.includes('Free capacity next resets at'),
          ),
        ).toBe(true);
    }
  });

  it('cancels while S1 is streaming and returns the session to idle', async () => {
    const { client, fake, events } = setup(1);
    await client.sessions.send('session_3' as never, { text: 'Fix the flaky tests' });
    for (let i = 0; i < 100 && !events.includes('session.delta'); i++) {
      fake.advance(100);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(events).toContain('session.delta');
    await client.sessions.cancel('session_3' as never);
    await flush(fake);
    expect(client.__state().sessions.find((session) => session.id === 'session_3')?.status).toBe(
      'idle',
    );
    const parts = (await client.sessions.get('session_3' as never)).messages.flatMap(
      (message) => message.parts,
    );
    expect(parts.every((part) => part.type !== 'tool_call' || part.status !== 'running')).toBe(
      true,
    );
  });
});

runFerryClientContract('mock+playback', async () => {
  const { client, fake } = setup(0);
  return {
    client,
    advance: async () => {
      await flush(fake, 3);
    },
  };
});
