import { describe, expect, it } from 'vitest';
import {
  checkPluginList,
  configuredMcpNames,
  configuredPlugins,
  disabledPluginOverrides,
  disabledServerOverrides,
  managedHooksConfigured,
  notifyStillConfigured,
  tomlKeySegment,
} from '../src/cli-transport/codex-config.js';

describe('configuredMcpNames', () => {
  it('reads configured MCP server names from the effective config payload', () => {
    expect(
      configuredMcpNames({
        config: { mcp_servers: { inline_server: {}, table_server: {}, 'quoted server': {} } },
      }),
    ).toEqual(['inline_server', 'table_server', 'quoted server']);
    expect(configuredMcpNames({ config: { mcp_servers: null } })).toEqual([]);
    expect(configuredMcpNames({ config: { mcp_servers: [] } })).toEqual([]);
    expect(configuredMcpNames(null)).toEqual([]);
  });
});

describe('configuredPlugins', () => {
  it('reads plugin ids and any bundled MCP server keys', () => {
    expect(
      configuredPlugins({
        config: {
          plugins: {
            'sentinel@local': { enabled: true, mcp_servers: { 'srv.one': { enabled: true } } },
            'plain@local': { enabled: true },
          },
        },
      }),
    ).toEqual({
      ids: ['sentinel@local', 'plain@local'],
      servers: { 'sentinel@local': ['srv.one'], 'plain@local': [] },
    });
    expect(configuredPlugins({ config: { plugins: 'nope' } })).toEqual({ ids: [], servers: {} });
    expect(configuredPlugins(null)).toEqual({ ids: [], servers: {} });
  });

  it('keeps a __proto__ plugin id as an own property of servers', () => {
    // JSON.parse defines `__proto__` as an own data property (an object literal would set the prototype).
    const payload: unknown = JSON.parse(
      '{"config":{"plugins":{"__proto__":{"mcp_servers":{"srv":{}}}}}}',
    );
    const result = configuredPlugins(payload);
    expect(Object.getOwnPropertyNames(result.servers)).toContain('__proto__');
    expect(Object.getOwnPropertyDescriptor(result.servers, '__proto__')?.value).toEqual(['srv']);
    expect(Object.getPrototypeOf(result.servers)).toBe(Object.prototype);
  });
});

describe('checkPluginList', () => {
  it('accepts a genuinely empty marketplace list', () => {
    expect(checkPluginList({ marketplaces: [] })).toEqual({ ok: true, enabledIds: [] });
  });

  it('reports still-enabled plugin ids from a well-formed payload', () => {
    const list = {
      marketplaces: [
        {
          plugins: [
            { id: 'a@local', enabled: true },
            { id: 'b@local', enabled: false },
          ],
        },
        { plugins: [{ id: 'd@remote', enabled: true }] },
      ],
    };
    expect(checkPluginList(list)).toEqual({ ok: true, enabledIds: ['a@local', 'd@remote'] });
  });

  it('fails closed on malformed, incomplete or unknown-enabled payloads', () => {
    expect(checkPluginList(null)).toEqual({ ok: false });
    expect(checkPluginList({})).toEqual({ ok: false });
    expect(checkPluginList({ marketplaces: 'nope' })).toEqual({ ok: false });
    expect(checkPluginList({ marketplaces: ['row'] })).toEqual({ ok: false });
    expect(checkPluginList({ marketplaces: [{}] })).toEqual({ ok: false });
    expect(checkPluginList({ marketplaces: [{ plugins: 'nope' }] })).toEqual({ ok: false });
    expect(checkPluginList({ marketplaces: [{ plugins: [{}] }] })).toEqual({ ok: false });
    // Unknown/missing enabled state must never be read as "off".
    expect(checkPluginList({ marketplaces: [{ plugins: [{ id: 'a@local' }] }] })).toEqual({
      ok: false,
    });
    expect(
      checkPluginList({ marketplaces: [{ plugins: [{ id: 'a@local', enabled: 'yes' }] }] }),
    ).toEqual({ ok: false });
    expect(checkPluginList({ marketplaces: [{ plugins: [{ id: '', enabled: true }] }] })).toEqual({
      ok: false,
    });
  });
});

describe('disabledServerOverrides / disabledPluginOverrides', () => {
  it('maps names to enabled:false and keeps __proto__ as an own property', () => {
    const overrides = disabledServerOverrides(['alpha', '__proto__', 'a.b']);
    expect(Object.getOwnPropertyNames(overrides)).toEqual(['alpha', '__proto__', 'a.b']);
    expect(Object.getOwnPropertyDescriptor(overrides, '__proto__')?.value).toEqual({
      enabled: false,
    });
    expect(Object.getPrototypeOf(overrides)).toBe(Object.prototype);
    expect(disabledServerOverrides([])).toEqual({});
  });

  it('disables each plugin and its declared MCP servers', () => {
    const overrides = disabledPluginOverrides({
      ids: ['sentinel@local', 'plain@local'],
      servers: { 'sentinel@local': ['srv.one'], 'plain@local': [] },
    });
    expect(overrides).toEqual({
      'sentinel@local': {
        enabled: false,
        mcp_servers: { 'srv.one': { enabled: false } },
      },
      'plain@local': { enabled: false },
    });
  });
});

describe('notifyStillConfigured', () => {
  it('is false only when notify is absent/null/empty', () => {
    expect(notifyStillConfigured({ config: { notify: [] } })).toBe(false);
    expect(notifyStillConfigured({ config: { notify: null } })).toBe(false);
    expect(notifyStillConfigured({ config: {} })).toBe(false);
    expect(notifyStillConfigured({ config: { notify: ['node', '-e', 'x'] } })).toBe(true);
    expect(notifyStillConfigured({ config: { notify: 'node' } })).toBe(true);
  });
});

describe('managedHooksConfigured', () => {
  it('detects admin-managed hook directories', () => {
    expect(managedHooksConfigured({ config: { hooks: { managed_dir: 'C:/m' } } })).toBe(true);
    expect(managedHooksConfigured({ config: { hooks: { windows_managed_dir: 'C:/m' } } })).toBe(
      true,
    );
    expect(managedHooksConfigured({ config: { hooks: { managed_dir: '  ' } } })).toBe(false);
    expect(managedHooksConfigured({ config: { hooks: { SessionStart: [] } } })).toBe(false);
    expect(managedHooksConfigured({ config: { hooks: null } })).toBe(false);
    expect(managedHooksConfigured({ config: {} })).toBe(false);
  });
});

describe('tomlKeySegment', () => {
  it('keeps bare keys bare and quotes/escapes the rest', () => {
    expect(tomlKeySegment('alpha_1')).toBe('alpha_1');
    expect(tomlKeySegment('a-b')).toBe('a-b');
    expect(tomlKeySegment('with space')).toBe('"with space"');
    expect(tomlKeySegment('a.b')).toBe('"a.b"');
    expect(tomlKeySegment('name@market')).toBe('"name@market"');
    expect(tomlKeySegment('with "q"')).toBe('"with \\"q\\""');
    expect(tomlKeySegment('back\\slash')).toBe('"back\\\\slash"');
  });
});
