import { join, resolve, isAbsolute } from 'node:path';

/** Compile a separate installer identity. Runtime flags cannot isolate NSIS shell folders. */
export function smokeConfiguration(config, include, root, namespace) {
  if (!isAbsolute(root) || !/^ferry-smoke-[a-z0-9-]+$/.test(namespace))
    throw new Error('Smoke builds require an absolute profile root and a unique smoke namespace.');
  const registry = `Software\\${namespace}`;
  const roaming = join(resolve(root), 'profile', 'Roaming');
  if (/[\r\n"$]/.test(roaming)) throw new Error('Unsafe NSIS smoke profile path');
  return {
    config: config
      .replace(/^appId: .*$/m, `appId: dev.ferry.${namespace}`)
      .replace(/^  output: .*$/m, `  output: ${JSON.stringify(join(root, 'release'))}`)
      .replace(/^  createDesktopShortcut: .*$/m, '  createDesktopShortcut: false')
      .replace(/^  createStartMenuShortcut: .*$/m, '  createStartMenuShortcut: false')
      .replace(/^  include: .*$/m, `  include: ${JSON.stringify(join(root, 'installer.nsh'))}`),
    include: include
      .replaceAll(
        'Software\\Classes\\Directory\\shell\\Ferry',
        `${registry}\\Classes\\Directory\\shell\\Ferry`,
      )
      .replaceAll('Software\\Ferry', `${registry}\\Preferences`)
      .replaceAll('HKCU "Environment"', `HKCU "${registry}\\Environment"`)
      .replaceAll('$APPDATA', roaming),
    registry,
    roaming,
  };
}
