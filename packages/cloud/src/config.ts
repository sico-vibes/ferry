import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
  cwd?: string;
  ferryHome?: string;
  readFile?: (path: string) => string | undefined;
}
/** Loads only Ferry cloud settings, with process environment taking precedence. */
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
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = options.ferryHome ?? env.FERRY_HOME;
  const files = [join(cwd, 'config', '.env')];
  let ancestor = cwd;
  while (dirname(ancestor) !== ancestor) {
    ancestor = dirname(ancestor);
    files.push(join(ancestor, 'config', '.env'));
  }
  if (home) files.push(join(home, 'config', '.env'), join(home, 'cloud.env'));
  const fileValues: Record<string, string> = {};
  for (const path of [...new Set(files)].reverse())
    Object.assign(fileValues, parseDotEnv(read(path) ?? ''));
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
