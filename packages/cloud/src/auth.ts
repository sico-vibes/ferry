import { FERRY_CLOUD_SCHEMA } from './config.js';
import { redactCloudPayload } from './redaction.js';
import type { FerrySupabaseClient } from './client.js';

export interface CloudAuthStatus {
  signedIn: boolean;
  email: string | null;
  userId: string | null;
  isOwner: boolean;
}
/** Supabase email/password auth wrapper with safe user-facing errors. */
export class CloudAuthService {
  readonly #listeners = new Set<(status: CloudAuthStatus) => void>();
  constructor(
    private readonly client: FerrySupabaseClient,
    private readonly schema = FERRY_CLOUD_SCHEMA,
  ) {
    client.auth.onAuthStateChange(() => {
      void this.emitStatus();
    });
  }
  async signInWithPassword(email: string, password: string): Promise<CloudAuthStatus> {
    let error: { message: string } | null;
    try {
      ({ error } = await this.client.auth.signInWithPassword({ email, password }));
    } catch (cause) {
      throw new Error(
        friendlyAuthError(cause instanceof Error ? cause.message : 'Network unavailable', password),
        { cause },
      );
    }
    if (error) throw new Error(friendlyAuthError(error.message, password));
    const status = await this.getStatus();
    this.emit(status);
    return status;
  }
  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw new Error(friendlyAuthError(error.message));
    this.emit(await this.getStatus());
  }
  async getStatus(): Promise<CloudAuthStatus> {
    const { data } = await this.client.auth.getUser();
    const user = data.user;
    if (!user) return { signedIn: false, email: null, userId: null, isOwner: false };
    const { data: admin } = await this.client
      .schema(this.schema)
      .from('admins')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();
    const role = (admin as { role?: unknown } | null)?.role;
    return {
      signedIn: true,
      email: user.email ?? null,
      userId: user.id,
      isOwner: role === 'owner',
    };
  }
  onChange(listener: (status: CloudAuthStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  private async emitStatus(): Promise<void> {
    this.emit(
      await this.getStatus().catch(() => ({
        signedIn: false,
        email: null,
        userId: null,
        isOwner: false,
      })),
    );
  }
  private emit(status: CloudAuthStatus): void {
    for (const listener of this.#listeners) listener(status);
  }
}
/** Converts Supabase auth failures to short messages with credentials removed. */
export function friendlyAuthError(message: string, sensitiveValue?: string): string {
  const safeMessage = sensitiveValue ? message.split(sensitiveValue).join('[REDACTED]') : message;
  const clean = redactCloudPayload(safeMessage) as string;
  if (/invalid login credentials|invalid email or password/i.test(clean))
    return 'Email or password is incorrect.';
  if (/email not confirmed/i.test(clean)) return 'Confirm your email before signing in.';
  if (/fetch failed|failed to fetch|network|econn|enotfound|timeout/i.test(clean))
    return 'Could not reach Ferry Cloud. Check your internet connection and try again.';
  return `Cloud sign-in failed: ${clean}`;
}
