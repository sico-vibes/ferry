import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fileMentions, readAttachments } from '../src/attachments.js';

it('extracts unique mentions and ignores inline email addresses', () => {
  expect(fileMentions('me@example.com @src/a.ts @"src/with spaces.ts" @src/a.ts')).toEqual([
    'src/a.ts',
    'src/with spaces.ts',
  ]);
});
it(
  'attaches text inside the project and rejects escapes, binary data and oversized files',
  { timeout: 30_000 },
  async () => {
    const base = fileURLToPath(new URL('../../../.dev/test-tmp/', import.meta.url));
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, 'attachments-'));
    try {
      const project = join(directory, 'project');
      await mkdir(project);
      await writeFile(join(project, 'with spaces.ts'), 'export const answer = 42;');
      await writeFile(join(directory, 'outside.ts'), 'private');
      await writeFile(join(project, 'binary'), '\0');
      await writeFile(join(project, 'huge'), 'x'.repeat(256 * 1024 + 1));
      expect(await readAttachments(project, ['with spaces.ts'])).toEqual([
        { name: 'with spaces.ts', text: 'export const answer = 42;' },
      ]);
      await expect(readAttachments(project, ['../outside.ts'])).rejects.toThrow(
        'outside the project',
      );
      await expect(readAttachments(project, ['binary'])).rejects.toThrow('binary');
      await expect(readAttachments(project, ['huge'])).rejects.toThrow('256 KiB');
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
