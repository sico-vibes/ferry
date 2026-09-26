import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { SettingsSchema, type Settings } from '@ferry/shared';
import { z } from 'zod';
import { redactKnownSecretText } from '@ferry/shared';

export interface DataPaths {
  home: string;
  db: string;
  logs: string;
  checkpoints: string;
  cache: string;
  skills: string;
  bin: string;
}

export function getDataPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DataPaths {
  const home =
    env.FERRY_HOME ??
    (platform === 'win32'
      ? join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Ferry')
      : join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'Ferry'));
  return {
    home,
    db: join(home, 'db'),
    logs: join(home, 'logs'),
    checkpoints: join(home, 'checkpoints'),
    cache: join(home, 'cache'),
    skills: join(home, 'skills'),
    bin: join(home, 'bin'),
  };
}

export async function ensureDataPaths(paths = getDataPaths()): Promise<DataPaths> {
  const directories = [
    paths.home,
    paths.db,
    paths.logs,
    paths.checkpoints,
    paths.cache,
    paths.skills,
    paths.bin,
  ];
  await Promise.all(directories.map((path) => mkdir(path, { recursive: true })));
  return paths;
}

const SettingsFileSchema = z.object({
  version: z.number().int().nonnegative(),
  settings: z.unknown(),
});
export const CURRENT_SETTINGS_VERSION = 1;
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({
  theme: 'system',
  homeStyle: 'auto',
  fontScale: 1,
  restoreTabs: true,
  allowSubscriptionOAuthRouting: false,
  subscriptionOAuthAcknowledged: [],
  delegationMode: 'suggest',
  permissionMode: 'ask',
  activeProfileId: 'default',
  onboardingComplete: false,
  optimizers: {
    terse: 'off',
    toolOutputFilters: true,
    recoveryHandles: true,
    contextHygiene: true,
    rtk: false,
  },
  developer: { showReferenceOverlay: false, mockLatency: false, injectErrors: false },
});

export function migrateSettings(version: number, data: unknown): unknown {
  if (version > CURRENT_SETTINGS_VERSION)
    throw new Error(
      `Settings file version ${String(version)} is newer than supported version ${String(CURRENT_SETTINGS_VERSION)}`,
    );
  let current = data;
  for (let next = version + 1; next <= CURRENT_SETTINGS_VERSION; next += 1) {
    if (next === 1 && typeof current === 'object' && current !== null) {
      const source = current as Partial<Settings>;
      current = {
        ...DEFAULT_SETTINGS,
        ...source,
        optimizers: { ...DEFAULT_SETTINGS.optimizers, ...source.optimizers },
        developer: { ...DEFAULT_SETTINGS.developer, ...source.developer },
      };
    }
  }
  return current;
}

export interface LoadSettingsOptions {
  filePath: string;
  defaults?: Settings;
  warn?: (message: string) => void;
}
export async function loadSettings({
  filePath,
  defaults = DEFAULT_SETTINGS,
  warn = console.warn,
}: LoadSettingsOptions): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const envelope = SettingsFileSchema.safeParse(parsed);
    const version = envelope.success ? envelope.data.version : 0;
    const source = envelope.success ? envelope.data.settings : parsed;
    const migrated = migrateSettings(version, source);
    return SettingsSchema.parse(migrated);
  } catch (error) {
    const backup = `${filePath}.invalid-${String(Date.now())}.bak`;
    await rename(filePath, backup);
    warn(
      `Invalid settings moved to ${backup}; using defaults (${error instanceof Error ? error.message : 'invalid file'})`,
    );
    return defaults;
  }
}

export async function saveSettings(filePath: string, settings: Settings): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ version: CURRENT_SETTINGS_VERSION, settings: SettingsSchema.parse(settings) }, null, 2)}\n`,
    'utf8',
  );
}

export const ProjectConfigSchema = z.object({
  gateCommands: z.array(z.string()).default([]),
  instructionsFile: z.string().nullable().default(null),
  defaultProfileId: z.string().nullable().default(null),
  permissionMode: z.enum(['ask', 'auto_edit', 'full_auto']).default('ask'),
  permissionRules: z
    .array(z.object({ pattern: z.string(), mode: z.enum(['ask', 'allow', 'deny']) }))
    .default([]),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export async function loadProjectConfig(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectConfig> {
  const filePath = join(projectPath, '.ferry', 'config.json');
  let source: unknown = {};
  try {
    source = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') source = {};
  }
  const parsedConfig = ProjectConfigSchema.safeParse(source);
  const config = parsedConfig.success ? parsedConfig.data : ProjectConfigSchema.parse({});
  const permissionMode = env.FERRY_PERMISSION_MODE;
  return ProjectConfigSchema.parse({
    ...config,
    ...(env.FERRY_GATE_COMMANDS
      ? { gateCommands: env.FERRY_GATE_COMMANDS.split(';').filter(Boolean) }
      : {}),
    ...(env.FERRY_INSTRUCTIONS_FILE ? { instructionsFile: env.FERRY_INSTRUCTIONS_FILE } : {}),
    ...(env.FERRY_DEFAULT_PROFILE ? { defaultProfileId: env.FERRY_DEFAULT_PROFILE } : {}),
    ...(permissionMode && ProjectConfigSchema.shape.permissionMode.safeParse(permissionMode).success
      ? { permissionMode }
      : {}),
  });
}

export interface LoggerFactoryOptions {
  logsDir: string;
  level?: string;
  name?: string;
  pretty?: boolean;
  direct?: boolean;
}
export function createLogger({
  logsDir,
  level = process.env.FERRY_LOG_LEVEL ?? 'info',
  name = 'ferry',
  pretty = false,
  direct = process.env.FERRY_LOG_DIRECT === 'true',
}: LoggerFactoryOptions): Logger {
  const redact: LoggerOptions['redact'] = {
    paths: [
      'authorization',
      'headers.authorization',
      'req.headers.authorization',
      'apiKey',
      '*.apiKey',
      'key',
      '*.key',
      'token',
      '*.token',
    ],
    censor: '[REDACTED]',
    remove: false,
  };
  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino-roll',
      level,
      options: { file: join(logsDir, `${name}.log`), frequency: 'daily', size: '10m', mkdir: true },
    },
  ];
  if (pretty) targets.push({ target: 'pino/file', level, options: { destination: 1 } });
  const options: LoggerOptions = {
    name,
    level,
    redact,
    serializers: { err: pino.stdSerializers.err },
    formatters: {
      log(object) {
        const safe: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(object)) safe[key] = sanitizeLogValue(value);
        return safe;
      },
    },
  };
  if (direct) {
    return pino(options, pino.destination({ dest: join(logsDir, `${name}.log`), sync: true }));
  }
  return pino(options, pino.transport({ targets }));
}
export function redactSecretText(text: string): string {
  return redactKnownSecretText(text)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(
      /\b(?:sk[-_](?:live|test)[-_][A-Za-z0-9_-]{8,}|rk_live_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      '[REDACTED]',
    );
}
function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) =>
        /^(authorization|api[-_]?key|key|token|password|secret)$/i.test(key)
          ? [key, '[REDACTED]']
          : [redactSecretText(key), sanitizeLogValue(item)],
      ),
    );
  }
  return value;
}
export function createSessionLogger(logger: Logger, sessionId: string): Logger {
  return logger.child({ sessionId });
}
