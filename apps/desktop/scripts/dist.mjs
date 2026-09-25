import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const env = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: resolve(repositoryRoot, '.dev', 'eb-cache'),
};

for (const args of [
  [resolve(packageRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'],
  [resolve(packageRoot, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', 'portable'],
]) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: packageRoot,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveResult(code ?? 1));
  });
  if (result !== 0) process.exit(result);
}

if (process.env.FERRY_SKIP_SMOKE !== '1') {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(packageRoot, 'scripts', 'smoke-packaged.mjs')], {
      cwd: packageRoot,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveResult(code ?? 1));
  });
  if (result !== 0) process.exit(result);
}
