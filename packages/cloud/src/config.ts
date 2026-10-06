import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const FERRY_CLOUD_SCHEMA = 'ferry';
export interface CloudConfig {
  url: string | undefined;
  publishableKey: string | undefined;
  schema: string;
  ownerEmail: string | undefined;
}
/** Parses dotenv assignments without evaluating shell syntax. */
export function parseDotEnv(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? '';
    const quoted = /^(?:"([\s\S]*?)"|'([\s\S]*?)')\s*(?:#.*)?$/.exec(value);
    if (quoted) value = quoted[1] ?? quoted[2] ?? '';
    else value = value.replace(/\s+#.*$/, '');
    if (key && /^(FERRY_SUPABASE_|FERRY_CLOUD_)/.test(key)) result[key] = value;
  }
  return result;
}
export interface CloudConfigOptions {
  env?: NodeJS.ProcessEnv;
  ferryHome?: string;
  readFile?: (path: string) => string | undefined;
}
/**
 * Loads only Ferry cloud settings. Sources, lowest to highest precedence: `<FERRY_HOME>/config/.env`,
 * `<FERRY_HOME>/cloud.env`, an explicit `FERRY_CLOUD_ENV_FILE`, then the process environment.
 * The working directory is never searched: a project Ferry opens must not be able to point cloud
 * mode (sign-in, synced prompts, Vault keys) at a different Supabase project.
 */
export function loadCloudConfig(options: CloudConfigOptions = {}): CloudConfig {
  const env = options.env ?? process.env;
  const read =
    options.readFile ??
    ((path: string) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    });
  const home = options.ferryHome ?? env.FERRY_HOME;
  const files: string[] = [];
  if (home) files.push(join(home, 'config', '.env'), join(home, 'cloud.env'));
  if (env.FERRY_CLOUD_ENV_FILE) files.push(resolve(env.FERRY_CLOUD_ENV_FILE));
  const fileValues: Record<string, string> = {};
  for (const path of files) Object.assign(fileValues, parseDotEnv(read(path) ?? ''));
  const value = (key: string) => env[key] ?? fileValues[key];
  return {
    url: value('FERRY_SUPABASE_URL'),
    publishableKey: value('FERRY_SUPABASE_PUBLISHABLE_KEY'),
    schema: value('FERRY_SUPABASE_SCHEMA') ?? FERRY_CLOUD_SCHEMA,
    ownerEmail: value('FERRY_CLOUD_OWNER_EMAIL'),
  };
}
/** Returns whether the URL and publishable key are available. */
export function isCloudConfigured(config: CloudConfig = loadCloudConfig()): boolean {
  return Boolean(config.url && config.publishableKey);
}
