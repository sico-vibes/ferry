import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rcedit } from 'rcedit';

export default async function setExecutableMetadata(context) {
  if (context.electronPlatformName !== 'win32') return;

  await cp(
    resolve(import.meta.dirname, '..', 'out', 'cli', 'node_modules'),
    resolve(context.appOutDir, 'resources', 'cli', 'node_modules'),
    { recursive: true, force: true },
  );

  await rcedit(resolve(context.appOutDir, 'Ferry.exe'), {
    icon: resolve(import.meta.dirname, '..', 'build', 'icon.ico'),
    'version-string': {
      ProductName: 'Ferry',
      FileDescription: 'Ferry',
      CompanyName: 'Ferry',
      LegalCopyright: `\u00A9 ${new Date().getFullYear()} Ferry contributors (MIT)`,
      OriginalFilename: 'Ferry.exe',
      InternalName: 'Ferry',
    },
    'file-version': context.packager.appInfo.version,
    'product-version': context.packager.appInfo.version,
  });
}
