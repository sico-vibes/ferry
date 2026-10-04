import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = readFileSync(resolve(process.cwd(), 'nsis/installer.nsh'), 'utf8');

function macro(name: string): string {
  const start = installer.indexOf('!macro ' + name);
  const end = installer.indexOf('!macroend', start);
  if (start < 0 || end < 0) throw new Error('NSIS macro ' + name + ' was not found.');
  return installer.slice(start, end);
}

describe('NSIS update preservation', () => {
  it('restores saved PATH and Explorer choices in the update install pass', () => {
    const init = macro('customInit');
    const install = macro('customInstall');

    expect(init.indexOf('ReadRegDWORD $AddToPathState')).toBeLessThan(
      init.indexOf('} $FerryInstallerParams "--updated"'),
    );
    expect(init.indexOf('ReadRegDWORD $ExplorerState')).toBeLessThan(
      init.indexOf('} $FerryInstallerParams "--updated"'),
    );
    expect(init).toContain('SetSilent silent');
    expect(install).not.toContain('Return');
    expect(install).toContain('FerryPathContainsEntry');
    expect(install).toContain('FerryRemovePathEntry');
    expect(install).toContain('ExplorerState');
  });

  it('skips cleanup from an updated uninstaller while keeping normal uninstall cleanup', () => {
    const init = macro('customUnInit');
    const uninstall = macro('customUnInstall');
    const updateGuard = uninstall.indexOf('${If} $UnFerryIsUpdated != 1');

    expect(init).toContain('} $0 "--updated"');
    expect(init).toContain('StrCpy $UnFerryIsUpdated 1');
    expect(updateGuard).toBeGreaterThan(-1);
    expect(uninstall.slice(updateGuard)).toContain('DeleteRegKey HKCU "Software\\Ferry"');
    expect(uninstall.slice(updateGuard)).toContain('RMDir /r "$APPDATA\\@ferry\\desktop"');
  });
});
