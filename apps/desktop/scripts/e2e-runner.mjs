import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const phases = [
  ['web UI flows', 'e2e.mjs'],
  ['real domains UI flow', 'e2e-real-domains.mjs'],
  ['Electron core smoke', 'e2e-electron.mjs'],
];
const results = [];

for (const [label, script] of phases) {
  console.log(`\n=== E2E: ${label} ===`);
  const result = spawnSync(process.execPath, [join(scriptsDirectory, script)], {
    cwd: dirname(scriptsDirectory),
    stdio: 'inherit',
    env: process.env,
  });
  results.push({ label, status: result.status, error: result.error });
}

console.log('\n=== E2E summary ===');
for (const result of results)
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${result.label}`);
if (results.some((result) => result.status !== 0 || result.error)) process.exitCode = 1;
