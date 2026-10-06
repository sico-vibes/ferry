import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { KeychainAuthStorage } from '@ferry/secrets';
import type { CloudConfig } from './config.js';

/** Async storage interface used by Supabase Auth's persisted session adapter. */
export interface AsyncKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
/** Creates the user-scoped Supabase client; only a publishable key is accepted. */
/** Supabase client accepted by Ferry's runtime configured-schema services. */
export type FerrySupabaseClient = SupabaseClient;
export function createCloudClient(
  config: CloudConfig,
  storage?: AsyncKeyValueStore,
): FerrySupabaseClient {
  if (!config.url || !config.publishableKey) throw new Error('Ferry cloud is not configured');
  const projectRef = new URL(config.url).hostname.split('.')[0] ?? 'supabase';
  return createClient(config.url, config.publishableKey, {
    db: { schema: config.schema },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: storage ?? new KeychainAuthStorage(projectRef),
    },
  }) as FerrySupabaseClient;
}
