// Fails if any tracked text file starts with a UTF-8 BOM (PowerShell tools add one silently,
// and a BOM breaks JSON.parse on package.json files).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|html|yml|yaml)$/;
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => TEXT.test(file) && existsSync(file));

const withBom = files.filter((file) => {
  const head = readFileSync(file).subarray(0, 3);
  return head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
});

if (withBom.length > 0) {
  console.error(
    `UTF-8 BOM found (save these files as UTF-8 without BOM):\n  ${withBom.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`check-text: ${String(files.length)} text files OK (no BOM)`);
