import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { glob as tinyGlob } from 'tinyglobby';
import { rgPath } from '@vscode/ripgrep';
import { z } from 'zod';
import { DEFAULT_MAX_FILE_BYTES, decodeText, encodeText, isBinary, WorkspaceJail } from './fs.js';

const writeLocks = new Map<string, Promise<void>>();
const renameRetryDelaysMs = [10, 20, 40, 80] as const;
function writeLockKey(file: string): string {
  const normalized = path.resolve(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
async function withRenameLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const key = writeLockKey(file);
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writeLocks.get(key) === current) writeLocks.delete(key);
  }
}
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = renameRetryDelaysMs[attempt];
      if ((code !== 'EPERM' && code !== 'EBUSY') || delay === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

export const ReadFileInput = z.object({
  path: z.string(),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
});
export const ListDirInput = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(0).max(20).default(1),
});
export const GlobInput = z.object({ pattern: z.string().min(1) });
export const GrepInput = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  context: z.number().int().min(0).max(10).default(0),
});
export const WriteFileInput = z.object({ path: z.string(), content: z.string() });
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  diff: string;
}
export interface GrepMatch {
  path: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export class WorkspaceTools {
  readonly jail: WorkspaceJail;
  constructor(
    root: string,
    readonly maxBytes = DEFAULT_MAX_FILE_BYTES,
  ) {
    this.jail = new WorkspaceJail(root);
  }
  async readFile(raw: unknown): Promise<string> {
    const input = ReadFileInput.parse(raw);
    const file = await this.jail.resolve(input.path);
    await this.assertVisible(file);
    const buffer = await fs.readFile(file);
    this.assertSize(buffer);
    if (isBinary(buffer)) throw new Error('Cannot read binary file as text');
    const { text } = decodeText(buffer);
    const lines = text.split(/\r\n|\n|\r/);
    const start = input.start ?? 1;
    const end = Math.min(input.end ?? lines.length, lines.length);
    return lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index)}: ${line}`)
      .join('\n');
  }
  async listDir(raw: unknown): Promise<string[]> {
    const input = ListDirInput.parse(raw);
    const base = await this.jail.resolve(input.path);
    await this.assertVisible(base);
    const result: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const target = path.join(dir, entry.name);
        if (await this.jail.isIgnored(target)) continue;
        result.push(this.jail.relative(target));
        if (entry.isDirectory() && depth < input.depth) await visit(target, depth + 1);
      }
    };
    await visit(base, 0);
    return result.sort();
  }
  async glob(raw: unknown): Promise<string[]> {
    const input = GlobInput.parse(raw);
    await this.jail.initialize();
    const files = await tinyGlob(input.pattern, {
      cwd: this.jail.root,
      onlyFiles: true,
      dot: true,
      ignore: ['.git/**', 'node_modules/**'],
    });
    const visible: string[] = [];
    for (const item of files) {
      const file = await this.jail.resolve(item);
      if (!(await this.jail.isIgnored(file))) visible.push(item.split(path.sep).join('/'));
    }
    return visible.sort().slice(0, 5000);
  }
  async grep(raw: unknown): Promise<GrepMatch[]> {
    const input = GrepInput.parse(raw);
    const base = input.path
      ? await this.jail.resolve(input.path)
      : (await this.jail.initialize(), this.jail.root);
    await this.assertVisible(base);
    const args = [
      '--json',
      '--line-number',
      '--color',
      'never',
      '--context',
      String(input.context),
      '--max-count',
      '200',
      '--max-filesize',
      `${String(this.maxBytes)}b`,
    ];
    if (input.glob) args.push('--glob', input.glob);
    args.push('--', input.pattern, base);
    const result = await execa(rgPath, args, {
      cwd: this.jail.root,
      reject: false,
      maxBuffer: 8 * 1024 * 1024,
    });
    if ((result.exitCode ?? 1) > 1) throw new Error(result.stderr || 'ripgrep failed');
    const matches: GrepMatch[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const event = JSON.parse(line) as {
        type: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
          submatches?: unknown[];
        };
      };
      if (event.type !== 'match' || !event.data?.path?.text) continue;
      const full = path.resolve(this.jail.root, event.data.path.text);
      if (!(await this.jail.resolve(this.jail.relative(full)))) continue;
      matches.push({
        path: this.jail.relative(full),
        line: event.data.line_number ?? 0,
        text: (event.data.lines?.text ?? '').replace(/\r?\n$/, ''),
        before: [],
        after: [],
      });
      if (matches.length >= 1000) break;
    }
    const lineCache = new Map<string, string[]>();
    for (const match of matches) {
      let lines = lineCache.get(match.path);
      if (!lines) {
        const buffer = await fs.readFile(await this.jail.resolve(match.path));
        if (isBinary(buffer)) continue;
        lines = decodeText(buffer).text.split(/\r\n|\n|\r/);
        lineCache.set(match.path, lines);
      }
      match.before = lines.slice(Math.max(0, match.line - input.context - 1), match.line - 1);
      match.after = lines.slice(match.line, match.line + input.context);
    }
    return matches;
  }
  async writeFile(raw: unknown): Promise<FileChange> {
    const input = WriteFileInput.parse(raw);
    const file = await this.jail.resolve(input.path, { allowMissing: true });
    await this.assertVisible(file);
    let before: string | null = null;
    let encoding: 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' = 'utf8';
    let eol = '\n';
    try {
      const b = await fs.readFile(file);
      this.assertSize(b);
      if (isBinary(b)) throw new Error('Cannot overwrite binary file');
      const decoded = decodeText(b);
      before = decoded.text;
      encoding = decoded.encoding;
      eol = decoded.lineEnding;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const normalized = input.content.replace(/\r\n|\r|\n/g, eol);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${String(process.pid)}.${String(Date.now())}.${globalThis.crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, encodeText(normalized, encoding), { flag: 'wx' });
      await withRenameLock(file, () => renameWithRetry(temp, file));
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      path: this.jail.relative(file),
      before,
      after: normalized,
      diff: unifiedDiff(before ?? '', normalized, input.path),
    };
  }
  async assertVisible(file: string): Promise<void> {
    if (await this.jail.isIgnored(file)) throw new Error('Path is ignored');
  }
  private assertSize(buffer: Buffer): void {
    if (buffer.byteLength > this.maxBytes)
      throw new Error(`File exceeds ${String(this.maxBytes)} byte limit`);
  }
}
export function unifiedDiff(before: string, after: string, name = 'file'): string {
  if (before === after) return '';
  const a = before.split(/\r\n|\n|\r/);
  const b = after.split(/\r\n|\n|\r/);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const out = [
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -${String(prefix + 1)},${String(a.length - prefix - suffix)} +${String(prefix + 1)},${String(b.length - prefix - suffix)} @@`,
  ];
  for (const line of a.slice(prefix, a.length - suffix)) out.push(`-${line}`);
  for (const line of b.slice(prefix, b.length - suffix)) out.push(`+${line}`);
  return out.join('\n');
}
