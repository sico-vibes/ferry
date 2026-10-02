// Fails if any tracked text file starts with a UTF-8 BOM (PowerShell tools add one silently,
// and a BOM breaks JSON.parse on package.json files).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|html|yml|yaml)$/;
const SOURCE = /\.(ts|tsx|js|mjs|cjs|json|css|html|yml|yaml)$/;
const FIXTURE_PATH = /(^|\/)(?:fixtures?|__fixtures__)(\/|$)|\.fixture\.[^/]+$/i;
const MOJIBAKE_MARKERS = [
  String.fromCodePoint(0x00c2),
  String.fromCodePoint(0x00e2, 0x20ac),
  String.fromCodePoint(0x00e2, 0x2014),
  String.fromCodePoint(0x00c3),
];
const specified = process.argv.slice(2);
const files = (
  specified.length > 0
    ? specified
    : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        encoding: 'utf8',
      }).split('\n')
).filter(
  (file) =>
    TEXT.test(file) &&
    existsSync(file) &&
    !file.replaceAll('\\', '/').includes('packages/catalog/data/vendor/'),
);

const withBom = files.filter((file) => {
  const head = readFileSync(file).subarray(0, 3);
  return head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
});

const mojibake = files
  .filter((file) => SOURCE.test(file) && !FIXTURE_PATH.test(file.replaceAll('\\', '/')))
  .flatMap((file) => {
    const content = readFileSync(file, 'utf8');
    const markers = MOJIBAKE_MARKERS.filter((marker) => content.includes(marker));
    return markers.length > 0 ? [`${file}: ${markers.join(', ')}`] : [];
  });

if (withBom.length > 0) {
  console.error(
    `UTF-8 BOM found (save these files as UTF-8 without BOM):\n  ${withBom.join('\n  ')}`,
  );
  process.exit(1);
}
if (mojibake.length > 0) {
  console.error(`Mojibake found in source files:\n  ${mojibake.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-text: ${String(files.length)} text files OK (no BOM)`);
