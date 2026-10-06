import type { OutboxRepository, StorageMirror } from '@ferry/storage';
import { CloudAuthService, type CloudAuthStatus } from './auth.js';
import { createCloudClient, type FerrySupabaseClient } from './client.js';
import type { CloudConfig } from './config.js';
import { CloudOutboxMirror } from './mirror.js';
import { CloudSyncWorker, type CloudSyncWorkerOptions } from './outbox-worker.js';
import { SupabaseVaultSecretStore, type ProviderKeyEvent } from './vault-secret-store.js';
import type { HydrationCounts } from './hydrate.js';

/** Dependencies and hooks used to build the cloud runtime. */
export interface CloudRuntimeOptions {
  config: CloudConfig;
  outbox: OutboxRepository;
  clientFactory?: (config: CloudConfig) => FerrySupabaseClient;
  captureContent?: boolean | (() => boolean);
  applyHydratedRows?: (
    table: string,
    rows: Record<string, unknown>[],
  ) => Promise<HydrationCounts | undefined> | HydrationCounts | undefined;
  workerOptions?: CloudSyncWorkerOptions;
  onProviderKeyEvent?: ProviderKeyEvent;
}
/** Services owned by a configured cloud-mode runtime. */
export interface CloudRuntime {
  client: FerrySupabaseClient;
  auth: CloudAuthService;
  sync: CloudSyncWorker;
  mirror: StorageMirror;
  secrets: SupabaseVaultSecretStore;
  initialize(): Promise<CloudAuthStatus>;
  dispose(): Promise<void>;
}

/** Builds the cloud runtime while keeping its Supabase client injectable for tests. */
export function createCloudRuntime(options: CloudRuntimeOptions): CloudRuntime {
  const client = (options.clientFactory ?? createCloudClient)(options.config);
  const auth = new CloudAuthService(client, options.config.schema);
  const sync = new CloudSyncWorker(
    client,
    options.outbox,
    options.config.schema,
    options.applyHydratedRows,
    options.workerOptions,
  );
  let signedIn = false;
  const secrets = new SupabaseVaultSecretStore(
    client,
    options.config.schema,
    options.onProviderKeyEvent,
    () => signedIn,
  );
  auth.onChange((status) => {
    signedIn = status.signedIn;
    if (!status.signedIn) secrets.clearCache();
    sync.setSignedIn(status.signedIn);
    if (status.signedIn) void sync.hydrate();
  });
  return {
    client,
    auth,
    sync,
    mirror: new CloudOutboxMirror(options.outbox, options.captureContent),
    secrets,
    async initialize() {
      const status = await auth
        .getStatus()
        .catch(() => ({ signedIn: false, email: null, userId: null, isOwner: false }));
      signedIn = status.signedIn;
      sync.setSignedIn(status.signedIn);
      sync.start();
      if (status.signedIn) void sync.hydrate();
      return status;
    },
    async dispose() {
      await sync.flush({ timeoutMs: 2_000 });
      sync.stop();
    },
  };
}
