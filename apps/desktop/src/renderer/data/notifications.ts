import type { Session } from '@ferry/shared';

export interface ChatNotification {
  kind: 'finished' | 'approval' | 'error';
  sessionId: string;
  title: string;
  body: string;
}

/**
 * Turns a chat's status change into an OS notification: a run that finishes, fails or stops to
 * ask for approval. The main process decides whether Ferry is out of sight and the kind is enabled.
 */
export function chatNotificationFor(
  previous: Session['status'] | undefined,
  next: Session,
): ChatNotification | null {
  const title = next.title.trim() || 'Ferry';
  if (next.status === 'awaiting_approval' && previous !== 'awaiting_approval')
    return {
      kind: 'approval',
      sessionId: next.id,
      title,
      body: 'Needs your approval to continue.',
    };
  if (previous !== 'running' && previous !== 'awaiting_approval') return null;
  if (next.status === 'idle')
    return { kind: 'finished', sessionId: next.id, title, body: 'Reply ready.' };
  if (next.status === 'error')
    return { kind: 'error', sessionId: next.id, title, body: 'Stopped with an error.' };
  return null;
}
