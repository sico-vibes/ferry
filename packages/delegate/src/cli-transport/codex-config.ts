import { isRecord } from './coerce.js';

/** Build a TOML key segment: bare when safe, otherwise a quoted/escaped key. */
export function tomlKeySegment(name: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name;
  return `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function effectiveConfig(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.config) ? value.config : value;
}

/**
 * Configured MCP server names from an app-server `config/read` payload. `config/read` is
 * non-activating metadata: reading it never starts an MCP process (verified against the installed
 * 0.162.1 app-server). Only the non-secret table keys are read.
 */
export function configuredMcpNames(value: unknown): string[] {
  const config = effectiveConfig(value);
  if (!config) return [];
  const servers = isRecord(config.mcp_servers) ? config.mcp_servers : null;
  return servers ? Object.keys(servers).filter((name) => name.trim().length > 0) : [];
}

export interface ConfiguredPlugins {
  /** Configured plugin ids (usually `name@marketplace`). */
  ids: string[];
  /** MCP server names declared/configured per plugin id, when present. */
  servers: Record<string, string[]>;
}

/**
 * Configured plugin ids and any plugin MCP server names from the effective config. Plugin MCP
 * servers are not listed under top-level `mcp_servers`; they are disabled by turning the plugin off
 * (`plugins.<id>.enabled=false`) and, when known, per bundled server.
 */
export function configuredPlugins(value: unknown): ConfiguredPlugins {
  const config = effectiveConfig(value);
  const plugins = config && isRecord(config.plugins) ? config.plugins : null;
  if (!plugins) return { ids: [], servers: {} };
  const ids: string[] = [];
  const serverEntries: [string, string[]][] = [];
  for (const id of Object.keys(plugins)) {
    if (!id.trim()) continue;
    ids.push(id);
    const entry = plugins[id];
    const mcp = isRecord(entry) && isRecord(entry.mcp_servers) ? entry.mcp_servers : null;
    serverEntries.push([id, mcp ? Object.keys(mcp).filter((name) => name.trim().length > 0) : []]);
  }
  // `Object.fromEntries` makes a `__proto__` plugin id an own property, never the prototype.
  return { ids, servers: Object.fromEntries(serverEntries) };
}

export type PluginListCheck = { ok: true; enabledIds: string[] } | { ok: false };

/**
 * Validate an app-server `plugin/list` payload and report any plugins still enabled after our
 * overrides. A genuinely empty `marketplaces: []` is valid. Anything malformed or with an unknown
 * `enabled` state is `{ ok: false }` so the caller fails the turn closed — an untrusted/incomplete
 * response must never be read as "all plugins off".
 */
export function checkPluginList(value: unknown): PluginListCheck {
  if (!isRecord(value)) return { ok: false };
  const marketplaces = value.marketplaces;
  if (!Array.isArray(marketplaces)) return { ok: false };
  const enabledIds: string[] = [];
  for (const marketplace of marketplaces) {
    if (!isRecord(marketplace)) return { ok: false };
    const plugins = marketplace.plugins;
    if (!Array.isArray(plugins)) return { ok: false };
    for (const plugin of plugins) {
      if (!isRecord(plugin)) return { ok: false };
      if (typeof plugin.id !== 'string' || plugin.id.trim().length === 0) return { ok: false };
      if (typeof plugin.enabled !== 'boolean') return { ok: false };
      if (plugin.enabled) enabledIds.push(plugin.id);
    }
  }
  return { ok: true, enabledIds };
}

/** True when the effective config still carries a non-empty notification command. */
export function notifyStillConfigured(value: unknown): boolean {
  const config = effectiveConfig(value);
  if (!config) return false;
  const notify = config.notify;
  if (notify === undefined || notify === null) return false;
  // A non-empty array (or any non-array value) means a notification command could still fire.
  return !Array.isArray(notify) || notify.length > 0;
}

/**
 * True when admin-managed lifecycle hooks are configured. These are enforced outside user config
 * (`hooks.managed_dir` / `hooks.windows_managed_dir`); Ferry cannot guarantee they are suppressed,
 * so the caller fails the turn closed rather than let them run host commands.
 */
export function managedHooksConfigured(value: unknown): boolean {
  const config = effectiveConfig(value);
  if (!config || !isRecord(config.hooks)) return false;
  const hooks = config.hooks;
  return ['managed_dir', 'windows_managed_dir', 'managedDir', 'windowsManagedDir'].some((key) => {
    const dir = hooks[key];
    return typeof dir === 'string' && dir.trim().length > 0;
  });
}

/**
 * Per-server disable map. Built with `Object.fromEntries` so a `__proto__` server name becomes an
 * own property instead of silently mutating the object prototype.
 */
export function disabledServerOverrides(
  names: readonly string[],
): Record<string, { enabled: false }> {
  return Object.fromEntries(names.map((name) => [name, { enabled: false }]));
}

export interface DisabledPluginOverride {
  enabled: false;
  mcp_servers?: Record<string, { enabled: false }>;
}

/** Per-plugin disable map, including per bundled MCP server when the names are known. */
export function disabledPluginOverrides(
  plugins: ConfiguredPlugins,
): Record<string, DisabledPluginOverride> {
  return Object.fromEntries(
    plugins.ids.map((id) => {
      const servers = plugins.servers[id] ?? [];
      return [
        id,
        servers.length > 0
          ? { enabled: false as const, mcp_servers: disabledServerOverrides(servers) }
          : { enabled: false as const },
      ];
    }),
  );
}
