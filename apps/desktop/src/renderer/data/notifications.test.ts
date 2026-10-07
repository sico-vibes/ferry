import { describe, expect, it } from 'vitest';
import type { Session } from '@ferry/shared';
import { chatNotificationFor } from './notifications';

const session = (status: Session['status']): Session =>
  ({ id: 'session_1', title: 'Fix the build', status }) as Session;

describe('chatNotificationFor', () => {
  it('announces a finished reply only after a run', () => {
    expect(chatNotificationFor('running', session('idle'))).toMatchObject({
      kind: 'finished',
      title: 'Fix the build',
    });
    expect(chatNotificationFor('idle', session('idle'))).toBeNull();
    expect(chatNotificationFor(undefined, session('idle'))).toBeNull();
  });

  it('announces errors and approvals', () => {
    expect(chatNotificationFor('running', session('error'))?.kind).toBe('error');
    expect(chatNotificationFor('running', session('awaiting_approval'))?.kind).toBe('approval');
    expect(chatNotificationFor('awaiting_approval', session('awaiting_approval'))).toBeNull();
  });

  it('announces a finish after an approval wait', () => {
    expect(chatNotificationFor('awaiting_approval', session('idle'))?.kind).toBe('finished');
  });
});
