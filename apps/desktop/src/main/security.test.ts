import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoreEnvironment } from './core-environment.js';

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
  });

  it('guards all IPC handlers and exposes only named preload capabilities', () => {
    expect(mainSource.match(/ipcMain\.handle\(/g)).toHaveLength(2);
    expect(mainSource.match(/ipcMain\.on\(/g)).toHaveLength(2);
    expect(mainSource).toContain('isTrustedSender(event)');
    expect(mainSource).toContain('event.sender === mainWindow.webContents');
    expect(mainSource).toContain('frame === event.sender.mainFrame');
    expect(mainSource).toContain('isTrustedRendererOrigin(frame.url)');
    expect(mainSource).toContain('EmptyIpcArgsSchema.parse(args)');
    expect(mainSource).toContain('OpenFolderResultSchema.parse(result.canceled');
    expect(mainSource).toContain('CoreHandoffTokenSchema.safeParse(rawToken)');
    expect(mainSource).toContain('DesktopThemeSchema.safeParse(rawTheme)');
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('ferryHost'");
    expect(preloadSource).toContain("send('ferry:connect-core', token)");
    expect(preloadSource).not.toMatch(/ipcRenderer\.(?:invoke|send)\(\s*\w+\s*,/);
    expect(preloadSource).not.toContain('invoke(channel');
  });

  it('denies renderer permissions and routes external links through the guarded opener', () => {
    expect(mainSource).toContain('setPermissionRequestHandler');
    expect(mainSource).toContain('callback(false)');
    expect(mainSource).toContain('setWindowOpenHandler');
    expect(mainSource).toContain("on('will-navigate'");
    expect(mainSource).toContain("on('will-redirect'");
    expect(mainSource).toContain('void openExternalSafely(url)');
    expect(mainSource).toContain("protocol === 'https:' || protocol === 'http:'");
    expect(mainSource).not.toMatch(/shell\.openExternal\(\s*[^u]/);
  });

  it('limits the E2E folder hook to un-packaged runs with an isolated user-data directory', () => {
    expect(mainSource).toMatch(
      /!app\.isPackaged && process\.env\.FERRY_E2E_USER_DATA_DIR && process\.env\.FERRY_E2E_OPEN_FOLDER/,
    );
  });

  it('queues MessagePort transfers until the utility process IPC listener is attached', () => {
    expect(mainSource).toContain('if (!coreProcess || !coreListening)');
    expect(mainSource).toContain("message.type === 'ferry:core-listening'");
    expect(mainSource).toContain(
      'for (const sender of coreConnectors.splice(0)) transferCorePort(sender)',
    );
  });

  it('uses a cryptographically random single-use MessagePort token and checks origin', async () => {
    expect(mainSource).toContain('consumedHandoffTokens.has(token.data)');
    expect(mainSource).toContain('CoreHandoffTokenSchema.safeParse(rawToken)');
    const rendererMain = await readFile(join(import.meta.dirname, '../renderer/main.tsx'), 'utf8');
    expect(rendererMain).toContain('crypto.getRandomValues');
    expect(rendererMain).toContain('event.source !== window');
    expect(rendererMain).toContain('event.origin !==');
    expect(rendererMain).toMatch(/location\.protocol === 'file:'\s*\?/);
    expect(preloadSource).toMatch(/rendererWindow\.location\.protocol === 'file:'\s*\?/);
  });
});
