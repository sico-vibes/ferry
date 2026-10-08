import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const usage = `Usage: node scripts/bench/run.mjs [--profile Auto-Free] [--tasks a,b] [--repeat N]
  [--cli <ferry.js|ferry.cmd>] [--keys-from-env | --use-stored-keys] [--out report.json]
  [--dry-run] [--help]
Live runs require an explicit key source. --dry-run runs the offline self-test.
Conformance accepts the same flags except --tasks, --repeat and --dry-run.`;

export function options(argv, conformance = false) {
  const result = {
    profile: 'Auto-Free',
    repeat: 1,
    cli: resolve(root, 'apps/cli/dist/ferry.js'),
    out: resolve(conformance ? 'conformance/report.json' : 'report.json'),
  };
  const booleans = new Set(['help', 'dry-run', 'keys-from-env', 'use-stored-keys']);
  const values = new Set(['profile', 'tasks', 'repeat', 'cli', 'out']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || (!booleans.has(flag) && !values.has(flag)))
      throw new Error(`Unknown option: ${argv[i]}`);
    if (conformance && ['tasks', 'repeat', 'dry-run'].includes(flag))
      throw new Error(`Unsupported conformance option: --${flag}`);
    if (booleans.has(flag)) result[flag] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${flag}`);
      result[flag] = value;
    }
  }
  result.repeat = Number(result.repeat);
  if (!Number.isSafeInteger(result.repeat) || result.repeat < 1)
    throw new Error('--repeat must be a positive integer');
  if (result['keys-from-env'] && result['use-stored-keys'])
    throw new Error('Choose exactly one key source');
  if (!result.help && !result['dry-run'] && !result['keys-from-env'] && !result['use-stored-keys'])
    throw new Error('Live runs require --keys-from-env or --use-stored-keys');
  result.cli = resolve(result.cli);
  result.out = resolve(result.out);
  return result;
}
