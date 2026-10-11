import { detectCli, type CliDetection } from '@ferry/delegate';
import { DelegationClientStatusSchema, type DelegationRun } from '@ferry/shared';

export async function delegationClientStatus(
  environment: NodeJS.ProcessEnv,
  runs: readonly DelegationRun[],
  checkAuth: boolean,
  probe: (
    id: 'codex' | 'opencode' | 'claude',
    options: { checkAuth: boolean; timeoutMs: number; environment: NodeJS.ProcessEnv },
  ) => Promise<CliDetection> = detectCli,
) {
  return Promise.all(
    (['codex', 'opencode', 'claude'] as const).map(async (id) => {
      const detected = await probe(id, { checkAuth, timeoutMs: 5000, environment });
      const completed = runs
        .filter((run) => run.implementer === id && run.status === 'completed' && run.usage !== null)
        .toSorted((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
      return DelegationClientStatusSchema.parse({
        id,
        installed: detected.available,
        signedIn:
          detected.available && checkAuth && detected.authStatus !== 'unknown'
            ? detected.authenticated
            : null,
        version: detected.version?.split(/\r?\n/)[0]?.slice(0, 128) ?? null,
        verifiedAt: completed?.finishedAt ?? null,
      });
    }),
  );
}
