import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export function fileMentions(text: string): string[] {
  return [
    ...new Set(
      Array.from(
        text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s]+))/g),
        (match) => match[1] ?? match[2] ?? '',
      ),
    ),
  ];
}

export async function readAttachments(root: string, paths: readonly string[]) {
  const directory = await realpath(root);
  return await Promise.all(
    paths.map(async (name) => {
      const path = await realpath(resolve(directory, name));
      const within = relative(directory, path);
      if (
        within === '..' ||
        within.startsWith('..\\') ||
        within.startsWith('../') ||
        isAbsolute(within)
      )
        throw new Error(`File is outside the project: ${name}`);
      const info = await stat(path);
      if (!info.isFile() || info.size > 256 * 1024)
        throw new Error(`Attach a text file smaller than 256 KiB: ${name}`);
      const text = await readFile(path, 'utf8');
      if (text.includes('\0')) throw new Error(`Cannot attach a binary file: ${name}`);
      return { name, text };
    }),
  );
}
