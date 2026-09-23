import type { Session } from '@ferry/shared';

export function createTranscripts(sessions: Session[]) {
  const messages = new Map<string, import('@ferry/shared').Message[]>();
  const flaky = sessions[2];
  const auth = sessions[1];
  if (!flaky || !auth) throw new Error('Transcript fixture sessions are missing');
  messages.set(flaky.id, [
    {
      id: 'message_flaky_user' as import('@ferry/shared').MessageId,
      sessionId: flaky.id,
      role: 'user',
      createdAt: flaky.updatedAt,
      modelRef: null,
      parts: [
        {
          type: 'text',
          id: 'part_flaky_user' as import('@ferry/shared').PartId,
          text: 'Find and fix the flaky tests in the CI suite.',
        },
      ],
    },
    {
      id: 'message_flaky_assistant' as import('@ferry/shared').MessageId,
      sessionId: flaky.id,
      role: 'assistant',
      createdAt: flaky.updatedAt,
      modelRef: 'cerebras/gpt-oss-120b' as import('@ferry/shared').ModelRef,
      parts: [
        {
          type: 'tool_call',
          id: 'part_plan' as import('@ferry/shared').PartId,
          tool: 'update_plan',
          title: 'Plan investigation',
          args: { steps: ['reproduce', 'fix', 'verify'] },
          status: 'succeeded',
          output: {
            text: 'Plan updated',
            filtered: false,
            originalTokens: null,
            filteredTokens: null,
            recoveryHandle: null,
          },
          changes: [],
          durationMs: 3,
        },
        {
          type: 'tool_call',
          id: 'part_grep' as import('@ferry/shared').PartId,
          tool: 'grep',
          title: 'Search flaky tests',
          args: { pattern: 'retry' },
          status: 'succeeded',
          output: {
            text: 'Found retry-sensitive test',
            filtered: true,
            originalTokens: null,
            filteredTokens: null,
            recoveryHandle: null,
          },
          changes: [],
          durationMs: 18,
        },
        {
          type: 'tool_call',
          id: 'part_edit' as import('@ferry/shared').PartId,
          tool: 'edit_file',
          title: 'Stabilize async assertion',
          args: { path: 'test/router.test.ts' },
          status: 'succeeded',
          output: null,
          changes: [
            {
              path: 'test/router.test.ts',
              status: 'modified',
              additions: 4,
              deletions: 2,
              before: 'expect(done).toBe(true)',
              after: 'await expect(done).resolves.toBe(true)',
            },
          ],
          durationMs: 28,
        },
        {
          type: 'tool_call',
          id: 'part_test' as import('@ferry/shared').PartId,
          tool: 'run_command',
          title: 'Run tests',
          args: { command: 'pnpm test' },
          status: 'succeeded',
          output: {
            text: '✓ 212 passed (4.1s)',
            filtered: true,
            originalTokens: 4823,
            filteredTokens: 11,
            recoveryHandle: 'recovery_test_1',
          },
          changes: [],
          durationMs: 4100,
        },
        {
          type: 'handoff_marker',
          id: 'part_handoff' as import('@ferry/shared').PartId,
          from: 'cerebras/gpt-oss-120b' as import('@ferry/shared').ModelRef,
          to: 'nvidia/nemotron-3-ultra' as import('@ferry/shared').ModelRef,
          reason: 'quota',
          briefingTokens: 3100,
          explanation: 'Moved to another free provider as the daily budget ran low.',
        },
        {
          type: 'text',
          id: 'part_flaky_final' as import('@ferry/shared').PartId,
          text: 'The race came from an unawaited async assertion. I awaited the promise and verified the suite: 212 tests passed.',
        },
      ],
    },
  ]);
  messages.set(auth.id, [
    {
      id: 'message_auth_user' as import('@ferry/shared').MessageId,
      sessionId: auth.id,
      role: 'user',
      createdAt: auth.updatedAt,
      modelRef: null,
      parts: [
        {
          type: 'text',
          id: 'part_auth_user' as import('@ferry/shared').PartId,
          text: 'How should I validate a bearer token in middleware?',
        },
      ],
    },
    {
      id: 'message_auth_assistant' as import('@ferry/shared').MessageId,
      sessionId: auth.id,
      role: 'assistant',
      createdAt: auth.updatedAt,
      modelRef: null,
      parts: [
        {
          type: 'text',
          id: 'part_auth_assistant' as import('@ferry/shared').PartId,
          text: 'Verify the signature, issuer, audience, and expiry before attaching the identity to the request.\n\n```ts\nconst claims = await verifyToken(token);\nrequest.user = claims;\n```',
        },
      ],
    },
  ]);

  return messages;
}
