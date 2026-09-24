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
    'package.json': '{"private":true,"workspaces":["packages/*"]}\n',
    'packages/a/package.json': '{"name":"a"}\n',
    'packages/a/src/index.ts': 'export const a = 1;\n',
    'packages/b/package.json': '{"name":"b"}\n',
    'packages/b/src/index.ts': 'export const b = 2;\n',
  },
};
export async function createFixtureRepo(
  template: keyof typeof templates = 'typescript',
): Promise<FixtureRepo> {
  const path = await mkdtemp(join(tmpdir(), 'ferry-fixture-'));
  for (const [relative, content] of Object.entries(templates[template] ?? {})) {
    const target = join(path, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await execa('git', ['init', '--quiet'], { cwd: path });
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
export const FixtureRepo = { create: createFixtureRepo, templates: Object.keys(templates) };
