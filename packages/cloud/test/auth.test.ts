import { describe, expect, it } from 'vitest';
import { CloudAuthService, type FerrySupabaseClient } from '../src/index.js';

describe('CloudAuthService', () => {
  it('signs in, reports owner status, emits changes and signs out', async () => {
    let currentUser: { id: string; email: string } | null = null;
    let signInArgs: { email: string; password: string } | undefined;
    const authCallback: { current: (() => void) | undefined } = { current: undefined };
    const fake = {
      auth: {
        onAuthStateChange: (callback: () => void) => {
          authCallback.current = callback;
          return { data: { subscription: { unsubscribe: () => undefined } } };
        },
        signInWithPassword: (args: { email: string; password: string }) => {
          signInArgs = args;
          currentUser = { id: 'user-1', email: args.email };
          authCallback.current?.();
          return Promise.resolve({ error: null });
        },
        signOut: () => {
          currentUser = null;
          authCallback.current?.();
          return Promise.resolve({ error: null });
        },
        getUser: () => Promise.resolve({ data: { user: currentUser }, error: null }),
      },
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { role: 'owner' }, error: null }),
            }),
          }),
        }),
      }),
    } as unknown as FerrySupabaseClient;
    const service = new CloudAuthService(fake);
    const changes: boolean[] = [];
    service.onChange((status) => changes.push(status.signedIn));
    const signedIn = await service.signInWithPassword('admin@example.com', 'private-password');
    expect(signInArgs).toEqual({ email: 'admin@example.com', password: 'private-password' });
    expect(signedIn).toMatchObject({
      signedIn: true,
      email: 'admin@example.com',
      userId: 'user-1',
      isOwner: true,
    });
    await service.signOut();
    expect(await service.getStatus()).toMatchObject({
      signedIn: false,
      email: null,
      isOwner: false,
    });
    expect(changes).toContain(true);
    expect(changes).toContain(false);
  });

  it('returns a friendly invalid-credentials error without exposing the password', async () => {
    const fake = {
      auth: {
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
        signInWithPassword: (args: { password: string }) =>
          Promise.resolve({
            error: { message: `Invalid login credentials ${args.password}` },
          }),
        signOut: () => Promise.resolve({ error: null }),
        getUser: () => Promise.resolve({ data: { user: null } }),
      },
      schema: () => ({
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
        }),
      }),
    } as unknown as FerrySupabaseClient;
    const service = new CloudAuthService(fake);
    await expect(
      service.signInWithPassword('a@example.com', 'test-password-value'),
    ).rejects.toThrow('Email or password is incorrect.');
  });
});
