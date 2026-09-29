import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

export interface FixtureRepo {
  path: string;
  cleanup: () => Promise<void>;
}
const templates: Record<string, Record<string, string>> = {
  typescript: {
    'package.json': '{"name":"fixture-ts","scripts":{"test":"node test.js"},"type":"module"}\n',
    'index.js': 'export const answer = 42;\n',
    'test.js':
      "import { answer } from './index.js';\nif (answer !== 0) throw new Error('intentional fixture failure');\n",
  },
  python: { 'test_example.py': 'def test_intentional_failure():\n    assert 1 == 0\n' },
  crlf: { 'README.md': 'CRLF fixture\r\nsecond line\r\n', 'source.txt': 'alpha\r\nbeta\r\n' },
  large: { 'large.txt': 'large fixture line\n'.repeat(100000) },
  monorepo: {
    'package.json':
      '{"private":true,"workspaces":["packages/*"],"scripts":{"test":"node test.js"},"type":"module"}\n',
    'packages/a/package.json': '{"name":"a"}\n',
    'packages/a/src/index.js': 'export const answer = 42;\n',
    'packages/b/package.json': '{"name":"b"}\n',
    'packages/b/src/index.js':
      "import { answer } from '../../a/src/index.js';\nexport const result = answer;\n",
    'test.js':
      "import { result } from './packages/b/src/index.js';\nif (result !== 42) throw new Error('expected 42');\n",
  },
  'noisy-test': {
    'package.json':
      '{"name":"fixture-noisy-tests","scripts":{"test":"node test.js"},"type":"module"}\n',
    'math.test.js': 'export const actual = 41;\n',
    'test.js':
      "import { actual } from './math.test.js';\nconsole.log(Array.from({length: 1200}, (_, i) => `PASS src/generated-${i}.test.js > generated case ${i}`).join('\\n'));\nconsole.error('FAIL src/math.test.js > addition > returns 42');\nconsole.error('AssertionError: expected 42, received ' + actual);\nconsole.error(' at src/math.test.js:8:12');\nprocess.exitCode = 1;\n",
  },
  'noisy-build': {
    'package.json':
      '{"name":"fixture-noisy-build","scripts":{"build":"node build.js"},"type":"module"}\n',
    'build.js':
      "for (let i = 0; i < 180; i += 1) console.error(`src/modules/module-${i}.ts:${i + 1}:5: error TS2322: Type 'string' is not assignable to type 'number'.`);\nconsole.error('Found 180 errors in 180 files. Build failed.');\nprocess.exitCode = 2;\n",
  },
};
export async function createFixtureRepo(
  template: keyof typeof templates = 'typescript',
  options: { initializeGit?: boolean } = {},
): Promise<FixtureRepo> {
  const path = await mkdtemp(join(tmpdir(), 'ferry-fixture-'));
  for (const [relative, content] of Object.entries(templates[template] ?? {})) {
    const target = join(path, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  if (options.initializeGit !== false) await execa('git', ['init', '--quiet'], { cwd: path });
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
  };
}
export const FixtureRepo = { create: createFixtureRepo, templates: Object.keys(templates) };
