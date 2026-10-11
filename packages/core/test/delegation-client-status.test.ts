import { expect, it } from 'vitest';
import { sampleDelegationRun } from '@ferry/shared/testing';
import { delegationClientStatus } from '../src/delegation-client-status.js';
it('keeps installation, explicit sign-in inspection and successful-run evidence separate', async () => {
  const probe = (id: 'codex' | 'opencode' | 'claude') =>
    Promise.resolve({
      available: id !== 'claude',
      authenticated: id === 'codex',
      version: 'fixture',
      executable: 'private-path',
      authStatus: id === 'opencode' ? ('unknown' as const) : ('signed_in' as const),
    });
  const run = {
    ...sampleDelegationRun,
    implementer: 'codex' as const,
    status: 'completed' as const,
    finishedAt: '2026-10-11T12:00:00.000Z',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: null,
      provider: 'subscription_cli' as const,
    },
  };
  const passive = await delegationClientStatus({}, [run], false, probe);
  expect(passive[0]).toMatchObject({ installed: true, signedIn: null, verifiedAt: run.finishedAt });
  const active = await delegationClientStatus({}, [run], true, probe);
  expect(active[0]?.signedIn).toBe(true);
  expect(active[1]?.signedIn).toBeNull();
  expect(active[2]).toMatchObject({ installed: false, signedIn: null, verifiedAt: null });
  expect(JSON.stringify(active)).not.toContain('private-path');
});
