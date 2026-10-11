import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { smokeConfiguration } from '../../scripts/smoke-config.mjs';

it('compiles smoke installers without real integration or profile destinations', () => {
  const config = readFileSync(resolve('electron-builder.yml'), 'utf8');
  const include = readFileSync(resolve('nsis/installer.nsh'), 'utf8');
  const isolated = smokeConfiguration(
    config,
    include,
    resolve("smoke user's 日本語"),
    'ferry-smoke-fixture',
  );
  expect(isolated.config).toContain('appId: dev.ferry.ferry-smoke-fixture');
  expect(isolated.config).toContain('createStartMenuShortcut: false');
  expect(isolated.config).toContain('createDesktopShortcut: false');
  expect(isolated.include).not.toContain('HKCU "Environment"');
  expect(isolated.include).not.toContain('"Software\\Ferry"');
  expect(isolated.include).not.toContain('"Software\\Classes\\Directory');
  expect(isolated.include).not.toContain('$APPDATA');
  expect(isolated.include).toContain('Software\\ferry-smoke-fixture\\Environment');
  expect(isolated.include).toContain('FERRY_UNINSTALL_DIRECTORY');
  expect(() => smokeConfiguration(config, include, resolve('tmp'), 'Ferry')).toThrow();
});
