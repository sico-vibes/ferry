import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be';
export type LineEnding = '\n' | '\r\n' | '\r';
export interface DecodedText {
  text: string;
  encoding: TextEncoding;
  lineEnding: LineEnding;
}
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export function decodeText(buffer: Buffer): DecodedText {
  let encoding: TextEncoding = 'utf8';
  let body = buffer;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    encoding = 'utf8-bom';
    body = buffer.subarray(3);
  } else if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    encoding = 'utf16le';
    body = buffer.subarray(2);
  } else if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    encoding = 'utf16be';
    body = buffer.subarray(2);
  }
  const text =
    encoding === 'utf16be'
      ? swapUtf16(body).toString('utf16le')
      : body.toString(encoding === 'utf16le' ? 'utf16le' : 'utf8');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const lineEnding: LineEnding =
    crlf >= lf && crlf >= cr && crlf > 0 ? '\r\n' : cr > lf && cr > 0 ? '\r' : '\n';
  return { text, encoding, lineEnding };
}
function swapUtf16(buffer: Buffer): Buffer {
  const out = Buffer.from(buffer);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const left = out[i];
    const right = out[i + 1];
    if (left !== undefined && right !== undefined) {
      out[i] = right;
      out[i + 1] = left;
    }
  }
  return out;
}
export function encodeText(text: string, encoding: TextEncoding): Buffer {
  if (encoding === 'utf8-bom')
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  if (encoding === 'utf16le')
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf16be')
    return Buffer.concat([Buffer.from([0xfe, 0xff]), swapUtf16(Buffer.from(text, 'utf16le'))]);
  return Buffer.from(text, 'utf8');
}
export function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

export class WorkspaceJail {
  readonly root: string;
  private realRoot: string | undefined;
  private ignoreMatcher = ignore();
  private ignoresLoaded = false;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  async initialize(): Promise<void> {
    this.realRoot = await fs.realpath(this.root);
    await this.loadIgnores();
  }
  async resolve(input: string, options: { allowMissing?: boolean } = {}): Promise<string> {
    if (!this.realRoot) await this.initialize();
    const realRoot = this.realRoot;
    if (!realRoot) throw new Error('Workspace root is unavailable');
    const candidate = path.resolve(this.root, input);
    if (!inside(this.root, candidate)) throw new Error('Path escapes workspace root');
    let checked: string;
    try {
      checked = await fs.realpath(candidate);
    } catch (error) {
      if (!options.allowMissing) throw error;
      let ancestor = path.dirname(candidate);
      const missing: string[] = [path.basename(candidate)];
      let realAncestor: string | undefined;
      while (!realAncestor) {
        try {
          realAncestor = await fs.realpath(ancestor);
        } catch {
          const parent = path.dirname(ancestor);
          if (parent === ancestor)
            throw new Error(`Cannot resolve path within workspace: ${input}`, { cause: error });
          missing.unshift(path.basename(ancestor));
          ancestor = parent;
        }
      }
      if (!inside(realRoot, realAncestor))
        throw new Error('Path escapes workspace root through a symlink', { cause: error });
      checked = path.join(realAncestor, ...missing);
    }
    if (!inside(realRoot, checked))
      throw new Error('Path escapes workspace root through a symlink');
    return checked;
  }
  relative(file: string): string {
    return path.relative(this.root, file).split(path.sep).join('/');
  }
  async isIgnored(file: string): Promise<boolean> {
    await this.loadIgnores();
    const rel = this.relative(file);
    if (rel === '') return false;
    let directory = false;
    try {
      directory = (await fs.stat(file)).isDirectory();
    } catch {
      /* missing target */
    }
    return this.isIgnoredRelative(directory ? `${rel}/` : rel);
  }
  async isIgnoredRelative(relativePath: string): Promise<boolean> {
    await this.loadIgnores();
    const rel = relativePath.split(path.sep).join('/').replace(/^\.\//, '');
    return rel !== '' && this.ignoreMatcher.ignores(rel);
  }
  private async loadIgnores(): Promise<void> {
    if (this.ignoresLoaded) return;
    this.ignoresLoaded = true;
    for (const name of ['.gitignore', '.ferryignore']) {
      try {
        this.ignoreMatcher.add(await fs.readFile(path.join(this.root, name), 'utf8'));
      } catch {
        /* optional ignore file */
      }
    }
  }
}
function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
