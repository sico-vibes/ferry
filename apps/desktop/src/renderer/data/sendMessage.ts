import type { FerryClient } from '@ferry/client';
import type { SessionId, Workspace } from '@ferry/shared';
import { useWorkspaceTrust } from '../state/workspaceTrust';

type SendInput = Parameters<FerryClient['sessions']['send']>[1];

/** Thrown when the user declines to trust a folder; callers keep the draft and stay quiet. */
export class SendCancelledError extends Error {
  constructor() {
    super('Sending was cancelled');
    this.name = 'SendCancelledError';
  }
}

function rpcKind(error: unknown): { kind: string; details: unknown } | null {
  if (!error || typeof error !== 'object' || !('kind' in error)) return null;
  const kind = error.kind;
  return typeof kind === 'string'
    ? { kind, details: (error as { details?: unknown }).details }
    : null;
}

/** Ask once for an untrusted folder, then mark it trusted. Returns false when the user declines. */
export async function ensureWorkspaceTrusted(
  client: FerryClient,
  workspace: Pick<Workspace, 'id' | 'name' | 'path'> & { trusted?: boolean; riskyRoot?: boolean },
): Promise<boolean> {
  if (workspace.trusted !== false) return true;
  const trusted = await useWorkspaceTrust.getState().request({
    workspaceId: workspace.id,
    name: workspace.name,
    path: workspace.path,
    riskyRoot: workspace.riskyRoot ?? false,
  });
  if (trusted) await client.workspaces.trust(workspace.id);
  return trusted;
}

/**
 * Send a message with friendly handling of the two expected refusals: an untrusted folder (ask,
 * trust, retry) and a chat that is still working (plain-language error).
 */
export async function sendMessage(
  client: FerryClient,
  sessionId: SessionId,
  input: SendInput,
): Promise<void> {
  try {
    await client.sessions.send(sessionId, input);
  } catch (error) {
    const rpc = rpcKind(error);
    if (rpc?.kind === 'workspace_untrusted') {
      const details = (rpc.details ?? {}) as { workspaceId?: string; riskyRoot?: boolean };
      const workspace = (await client.workspaces.list()).find(
        (item) => item.id === details.workspaceId,
      );
      if (!workspace) throw error;
      const trusted = await ensureWorkspaceTrusted(client, {
        ...workspace,
        trusted: false,
        riskyRoot: details.riskyRoot ?? false,
      });
      if (!trusted) throw new SendCancelledError();
      await client.sessions.send(sessionId, input);
      return;
    }
    if (rpc?.kind === 'gateway_not_running')
      throw new Error(
        'The Gateway is off. Start it from the Gateway page or the model picker, then send again.',
        { cause: error },
      );
    if (rpc?.kind === 'conflict')
      throw new Error('This chat is still working. Wait for it to finish or press Stop.', {
        cause: error,
      });
    throw error;
  }
}
