import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'turbo', 'bin', 'turbo'),
    'run',
    'typecheck',
    'lint',
    'test',
    '--affected',
  ],
  { stdio: 'inherit', cwd: root },
);
const changed = execFileSync('git', ['diff', '--name-only', 'HEAD', '--'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file && existsSync(file));
execFileSync(process.execPath, [join(root, 'scripts', 'check-text.mjs'), ...changed], {
  stdio: 'inherit',
});
const formatFiles = changed.filter((file) =>
  /\.(ts|tsx|js|mjs|cjs|json|md|css|html|yml|yaml)$/.test(file),
);
if (formatFiles.length > 0) {
  execFileSync(
    process.execPath,
    [join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs'), '--check', ...formatFiles],
    { stdio: 'inherit', cwd: root },
  );
}
