import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoreEnvironment } from './core-environment.js';
import { isTrustedRendererOrigin } from './renderer-origin.js';
import { isExpectedCorePortOrigin } from '../shared/core-port-origin.js';
import { isAllowlistedExternal } from './external-links.js';

const mainSource = await readFile(join(import.meta.dirname, 'index.ts'), 'utf8');
const preloadSource = await readFile(join(import.meta.dirname, '../preload/index.ts'), 'utf8');
const rendererHtml = await readFile(join(import.meta.dirname, '../renderer/index.html'), 'utf8');

describe('Electron security boundary', () => {
  it('restricts packaged core environment and permits test overrides only in isolated E2E runs', () => {
    const source = {
      PATH: 'system-path',
      SECRET_TOKEN: 'must-not-cross',
      FERRY_PROVIDER_BASE_URL_GROQ: 'http://127.0.0.1:43123/groq',
      FERRY_TEST_KEYRING_NAMESPACE: 'fixture-keyring',
      FERRY_E2E_USER_DATA_DIR: 'C:/tmp/ferry-e2e',
      FERRY_E2E_PROVIDER_KEY: 'fixture-key',
    };

    expect(buildCoreEnvironment(source, true)).toEqual({ PATH: 'system-path' });
    expect(buildCoreEnvironment({ ...source, FERRY_E2E_USER_DATA_DIR: '' }, false)).toEqual({
      PATH: 'system-path',
    });
    expect(buildCoreEnvironment(source, false)).toMatchObject({
      FERRY_PROVIDER_BASE_URL_GROQ: 'http://127.0.0.1:43123/groq',
      FERRY_TEST_KEYRING_NAMESPACE: 'fixture-keyring',
      FERRY_E2E_USER_DATA_DIR: 'C:/tmp/ferry-e2e',
      FERRY_E2E_PROVIDER_KEY: 'fixture-key',
    });
    expect(buildCoreEnvironment(source, false)).not.toHaveProperty('SECRET_TOKEN');
  });

  it('keeps renderer isolation and sandbox preferences enabled', () => {
    expect(mainSource).toMatch(/contextIsolation:\s*true/);
    expect(mainSource).toMatch(/sandbox:\s*true/);
    expect(mainSource).toMatch(/nodeIntegration:\s*false/);
    expect(mainSource).toMatch(/webviewTag:\s*false/);
    expect(mainSource).toMatch(
      /devTools:\s*!app\.isPackaged\s*\|\|\s*process\.env\.FERRY_DEBUG_TOOLS/,
    );
    expect(mainSource).not.toMatch(/enableBlinkFeatures\s*:/);
  });

  it('uses a strict CSP and permits inline styles only', () => {
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
      rendererHtml,
    )?.[1];
    expect(policy).toBeDefined();
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toContain('ws://127.0.0.1');
  });

  it('guards all IPC handlers and exposes only named preload capabilities', () => {
    expect(mainSource.match(/ipcMain\.handle\(/g)).toHaveLength(17);
    expect(mainSource.match(/ipcMain\.on\(/g)).toHaveLength(2);
    expect(mainSource).toContain('isTrustedSender(event)');
    expect(mainSource).toContain('event.sender === mainWindow.webContents');
    expect(mainSource).toContain('frame === event.sender.mainFrame');
    expect(mainSource).toContain('isTrustedRendererUrl(frame.url)');
    expect(mainSource).toContain('EmptyIpcArgsSchema.parse(args)');
    expect(mainSource).toContain('OpenFolderResultSchema.parse(result.canceled');
    expect(mainSource).toContain('CoreHandoffTokenSchema.safeParse(rawToken)');
    expect(mainSource).toContain('DesktopThemeSchema.safeParse(rawTheme)');
    expect(mainSource).toContain("ipcMain.handle('ferry:update-state'");
    expect(mainSource).toContain("ipcMain.handle('ferry:update-check'");
    expect(mainSource).toContain("ipcMain.handle('ferry:update-auto-download'");
    expect(mainSource).toContain("ipcMain.handle('ferry:update-install'");
    expect(mainSource).toContain("ipcMain.handle('ferry:update-download'");
    expect(mainSource).toContain("ipcMain.handle('ferry:process-metrics'");
    expect(mainSource).toContain("ipcMain.handle('ferry:engine-status'");
    expect(mainSource).toContain("ipcMain.handle('ferry:reveal-data-folder'");
    expect(mainSource).toContain("ipcMain.handle('ferry:app-info'");
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:app-info',[\s\S]*?if \(!isTrustedSender\(event\)\) throw new Error\('Untrusted IPC sender'\);[\s\S]*?EmptyIpcArgsSchema\.parse\(args\);/,
    );
    expect(mainSource).toContain("ipcMain.handle('ferry:relaunch'");
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:relaunch',[\s\S]*?if \(!isTrustedSender\(event\)\) throw new Error\('Untrusted IPC sender'\);[\s\S]*?EmptyIpcArgsSchema\.parse\(args\);/,
    );
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:engine-status',[\s\S]*?if \(!isTrustedSender\(event\)\) throw new Error\('Untrusted IPC sender'\);[\s\S]*?EmptyIpcArgsSchema\.parse\(args\);/,
    );
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:reveal-data-folder',[\s\S]*?if \(!isTrustedSender\(event\)\) throw new Error\('Untrusted IPC sender'\);[\s\S]*?OpenFolderResultSchema\.parse\(rawPath\)/,
    );
    expect(mainSource).toContain("webContents.send('ferry:window-background'");
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:process-metrics',[\s\S]*?if \(!isTrustedSender\(event\)\) throw new Error\('Untrusted IPC sender'\);[\s\S]*?EmptyIpcArgsSchema\.parse\(args\);/,
    );
    // Tray and notification preferences: trusted sender, and only parsed, typed input.
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:shell-preferences',[\s\S]*?if \(!isTrustedSender\(event\)\) throw new Error\('Untrusted IPC sender'\);[\s\S]*?EmptyIpcArgsSchema\.parse\(args\);/,
    );
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:shell-preferences-set',[\s\S]*?if \(!isTrustedSender\(event\)\) throw new Error\('Untrusted IPC sender'\);[\s\S]*?parseShellPreferencePatch\(patch\)/,
    );
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:notify',[\s\S]*?if \(!isTrustedSender\(event\)\) throw new Error\('Untrusted IPC sender'\);[\s\S]*?parseShellNotification\(input\)/,
    );
    expect(preloadSource).toContain('notify:');
    expect(preloadSource).toContain('onShellCommand:');
    expect(preloadSource).toContain('getProcessMetrics:');
    expect(preloadSource).toContain('getEngineStatus:');
    expect(preloadSource).toContain('revealDataFolder:');
    expect(preloadSource).toContain('isWindowBackgrounded:');
    expect(preloadSource).toContain('onWindowBackground:');
    expect(mainSource).toContain("ipcMain.handle('ferry:keybindings-read'");
    expect(mainSource).toContain("ipcMain.handle('ferry:keybindings-write'");
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:keybindings-read',[\s\S]*?if \(!isTrustedSender\(event\)\)/,
    );
    expect(mainSource).toMatch(
      /ipcMain\.handle\('ferry:keybindings-write',[\s\S]*?if \(!isTrustedSender\(event\)/,
    );
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('ferryHost'");
    expect(preloadSource).toContain('readKeybindings:');
    expect(preloadSource).toContain('writeKeybindings:');
    expect(preloadSource).toContain('onKeybindingsChanged:');
    expect(preloadSource).toContain("send('ferry:connect-core', token)");
    expect(preloadSource).not.toMatch(/ipcRenderer\.(?:invoke|send)\(\s*\w+\s*,/);
    expect(preloadSource).not.toContain('invoke(channel');
  });

  it('trusts hash-routed file renderers while rejecting foreign file origins', () => {
    expect(
      isTrustedRendererOrigin(
        'file:///C:/Ferry/renderer/index.html#/explore',
        undefined,
        'file:///C:/Ferry/renderer/index.html',
      ),
    ).toBe(true);
    expect(
      isTrustedRendererOrigin(
        'file://untrusted-host/renderer/index.html#/explore',
        undefined,
        'file:///C:/Ferry/renderer/index.html',
      ),
    ).toBe(false);
    expect(
      isTrustedRendererOrigin('http://127.0.0.1:5173/#/explore', 'http://127.0.0.1:5173'),
    ).toBe(true);
    expect(
      isTrustedRendererOrigin('http://127.0.0.1:5174/#/explore', 'http://127.0.0.1:5173'),
    ).toBe(false);
  });

  it('canonicalizes Windows short paths, drive casing, escaped tildes, and asar renderer paths', () => {
    const canonicalizeWindowsPath = (value: string) =>
      value
        .replace(/^([a-z]):/i, (_match, drive: string) => `${drive.toUpperCase()}:`)
        .replace(/\\Users\\RUNNER~1(?=\\|$)/i, '\\Users\\runneradmin');
    const windows = { platform: 'win32' as const, canonicalize: canonicalizeWindowsPath };

    expect(
      isTrustedRendererOrigin(
        'file:///C:/Users/RUNNER~1/AppData/Local/Temp/ferry/app.asar/out/renderer/index.html#/explore',
        undefined,
        'file:///C:/Users/runneradmin/AppData/Local/Temp/ferry/app.asar/out/renderer/index.html',
        windows,
      ),
    ).toBe(true);
    expect(
      isTrustedRendererOrigin(
        'file:///c:/Ferry/renderer/index.html',
        undefined,
        'file:///C:/Ferry/renderer/index.html',
        windows,
      ),
    ).toBe(true);
    expect(
      isTrustedRendererOrigin(
        'file:///C:/Users/RUNNER%7E1/AppData/Local/Ferry/renderer/index.html',
        undefined,
        'file:///C:/Users/runneradmin/AppData/Local/Ferry/renderer/index.html',
        windows,
      ),
    ).toBe(true);
  });

  it('uses case-sensitive POSIX renderer paths', () => {
    const posix = { platform: 'linux' as const, canonicalize: (value: string) => value };

    expect(
      isTrustedRendererOrigin(
        'file:///opt/Ferry/renderer/index.html',
        undefined,
        'file:///opt/ferry/renderer/index.html',
        posix,
      ),
    ).toBe(false);
    expect(
      isTrustedRendererOrigin(
        'file:///opt/ferry/renderer/index.html',
        undefined,
        'file:///opt/ferry/renderer/index.html',
        posix,
      ),
    ).toBe(true);
  });

  it('accepts opaque file MessageEvent origins only for the token-bound main window', () => {
    expect(isExpectedCorePortOrigin('file:', 'null', 'null')).toBe(true);
    expect(isExpectedCorePortOrigin('file:', 'file://', 'null')).toBe(false);
    expect(isExpectedCorePortOrigin('file:', 'https://attacker.invalid', 'null')).toBe(false);
    expect(
      isExpectedCorePortOrigin('http:', 'http://127.0.0.1:5173', 'http://127.0.0.1:5173'),
    ).toBe(true);
    expect(
      isExpectedCorePortOrigin('http:', 'http://127.0.0.1:5174', 'http://127.0.0.1:5173'),
    ).toBe(false);
  });

  it('denies renderer permissions and routes external links through the guarded opener', () => {
    expect(mainSource).toContain('setPermissionRequestHandler');
    expect(mainSource).toContain('setPermissionCheckHandler(() => false)');
    expect(mainSource).toContain('callback(false)');
    expect(mainSource).toContain('setWindowOpenHandler');
    expect(mainSource).toContain("on('will-navigate'");
    expect(mainSource).toContain("on('will-redirect'");
    expect(mainSource).toContain('void openExternalSafely(url)');
    expect(isAllowlistedExternal('https://opencode.ai/auth')).toBe(true);
    expect(isAllowlistedExternal('https://console.groq.com/keys')).toBe(true);
    expect(isAllowlistedExternal('https://cloud.cerebras.ai')).toBe(true);
    expect(isAllowlistedExternal('https://evil.example')).toBe(false);
    expect(isAllowlistedExternal('file:///etc/passwd')).toBe(false);
    expect(mainSource).not.toMatch(/shell\.openExternal\(\s*[^u]/);
  });

  it('limits the E2E folder hook to un-packaged runs with an isolated user-data directory', () => {
    expect(mainSource).toMatch(
      /\(!app\.isPackaged \|\| process\.env\.FERRY_E2E_PACKAGED === '1'\)[\s\S]*process\.env\.FERRY_E2E_USER_DATA_DIR[\s\S]*process\.env\.FERRY_E2E_OPEN_FOLDER/,
    );
  });

  it('queues MessagePort transfers until the utility process IPC listener is attached', () => {
    expect(mainSource).toContain('if (!coreProcess || !coreListening)');
    expect(mainSource).toContain("message.type === 'ferry:core-listening'");
    expect(mainSource).toContain('for (const connector of coreConnectors.splice(0))');
    expect(mainSource).toContain("canonicalizePath(join(import.meta.dirname, 'core-entry.js'))");
    expect(mainSource).toContain("process.env.FERRY_INSTALL_SMOKE === 'true'");
    expect(mainSource).toContain(
      'const e2eTracing = Boolean(process.env.FERRY_E2E_USER_DATA_DIR) || installSmoke',
    );
  });

  it('requests a replacement core port before waiting for the core ready event', async () => {
    const rendererMain = await readFile(join(import.meta.dirname, '../renderer/main.tsx'), 'utf8');
    expect(rendererMain).toContain('return connectCorePort(host, rpcClientId)');
    expect(rendererMain).not.toContain('waitForCoreConnected');
  });

  it('uses a cryptographically random single-use MessagePort token and checks origin', async () => {
    expect(mainSource).toContain('consumedHandoffTokens.has(token.data)');
    expect(mainSource).toContain('CoreHandoffTokenSchema.safeParse(rawToken)');
    const rendererMain = await readFile(join(import.meta.dirname, '../renderer/main.tsx'), 'utf8');
    expect(rendererMain).toContain('crypto.getRandomValues');
    expect(rendererMain).toContain('event.source !== window');
    expect(rendererMain).toContain(
      'isExpectedCorePortOrigin(location.protocol, event.origin, location.origin)',
    );
    expect(preloadSource).toMatch(/rendererWindow\.location\.protocol === 'file:'\s*\?/);
    expect(preloadSource).toContain(
      "postMessage({ type: 'ferry:core-port' }, targetOrigin, [port])",
    );
    expect(preloadSource).not.toMatch(/postMessage\(\{[^}]*token/);
  });
});
