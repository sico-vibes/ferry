// Guards the user's real Windows Credential Manager entries while tests launch the packaged app.
// A packaged build once wrote test keys into the real "Ferry" keyring and destroyed a real provider
// key; tests now use their own service (see core-environment.ts) and assert the real one is intact.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { Entry } = createRequire(join(root, 'packages', 'secrets', 'package.json'))(
  '@napi-rs/keyring',
);

/** Provider accounts tests may write; extend when a test sets another provider's key. */
export const GUARDED_ACCOUNTS = ['openrouter', 'groq', 'cerebras', 'gemini', 'openai', 'anthropic'];

function read(service, account) {
  try {
    return new Entry(service, account).getPassword() ?? null;
  } catch {
    return null;
  }
}

/** Hashes (never the secrets) of the real Ferry entries, to compare after the run. */
export function snapshotRealKeyring(accounts = GUARDED_ACCOUNTS) {
  return Object.fromEntries(
    accounts.map((account) => {
      const value = read('Ferry', account);
      return [account, value === null ? null : createHash('sha256').update(value).digest('hex')];
    }),
  );
}

/** Throws (naming accounts only) when a real Ferry entry changed during the run. */
export function assertRealKeyringUnchanged(before) {
  const after = snapshotRealKeyring(Object.keys(before));
  const changed = Object.keys(before).filter((account) => before[account] !== after[account]);
  if (changed.length)
    throw new Error(
      `The test changed the real Ferry keyring entries: ${changed.join(', ')}. Tests must use their own keyring service.`,
    );
}

/** Removes what the run stored under its own test service. */
export function cleanupTestKeyring(service, accounts = GUARDED_ACCOUNTS) {
  if (!service || service.toLowerCase() === 'ferry') return;
  for (const account of accounts)
    try {
      new Entry(service, account).deleteCredential();
    } catch {
      /* nothing stored */
    }
}
