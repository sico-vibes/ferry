import { promises as fs } from 'node:fs';
import path from 'node:path';
import DiffMatchPatch from 'diff-match-patch';
import { z } from 'zod';
import { decodeText, encodeText, isBinary } from './fs.js';
import { unifiedDiff, type FileChange, WorkspaceTools } from './tools.js';

export const EditFileInput = z.object({
  path: z.string(),
  edits: z.array(z.object({ search: z.string(), replace: z.string() }).strict()).min(1),
});
export const PathPairInput = z.object({ from: z.string(), to: z.string() });
export const DeleteInput = z.object({ path: z.string() });
export const PatchInput = z.object({ patch: z.string() });
const dmp = new DiffMatchPatch();

export async function editFile(tools: WorkspaceTools, raw: unknown): Promise<FileChange> {
  const input = EditFileInput.parse(raw);
  const file = await tools.jail.resolve(input.path);
  await tools.assertVisible(file);
  const buffer = await fs.readFile(file);
  if (isBinary(buffer)) throw new Error('Cannot edit binary file');
  const decoded = decodeText(buffer);
  let after = decoded.text;
  for (const edit of input.edits) {
    const occurrences = count(after, edit.search);
    if (occurrences === 1) {
      after = after.replace(edit.search, edit.replace);
      continue;
    }
    if (occurrences > 1)
      throw new Error('Exact edit is ambiguous; search block occurs more than once');
    const needle = normalizeWhitespace(edit.search);
    const normalized = normalizeWhitespace(after);
    if (needle && count(normalized, needle) === 1) {
      const index = normalized.indexOf(needle);
      const bounds = mapNormalizedBounds(after, index, needle.length);
      after = after.slice(0, bounds.start) + edit.replace + after.slice(bounds.end);
      continue;
    }
    const patches = dmp.patch_make(edit.search, edit.replace);
    const [result, applied] = dmp.patch_apply(patches, after);
    if (applied.every(Boolean) && similarity(result, after) >= 0.55) {
      after = result;
      continue;
    }
    throw new Error('Edit block could not be matched with sufficient confidence');
  }
  const output = after.replace(/\r\n|\r|\n/g, decoded.lineEnding);
  await fs.writeFile(file, encodeText(output, decoded.encoding));
  return {
    path: tools.jail.relative(file),
    before: decoded.text,
    after: output,
    diff: unifiedDiff(decoded.text, output, input.path),
  };
}
function count(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}
function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
function mapNormalizedBounds(
  text: string,
  start: number,
  length: number,
): { start: number; end: number } {
  const positions: number[] = [];
  let wasSpace = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i] ?? '';
    const space = /\s/.test(character);
    if (space && wasSpace) continue;
    positions.push(i);
    wasSpace = space;
  }
  const begin = positions[start] ?? 0;
  const last = positions[start + length - 1] ?? begin;
  return { start: begin, end: last + 1 };
}
function similarity(a: string, b: string): number {
  const diff = dmp.diff_main(a, b);
  dmp.diff_cleanupEfficiency(diff);
  const distance = diff.reduce((n, entry) => n + (entry[0] === 0 ? 0 : entry[1].length), 0);
  return 1 - distance / Math.max(a.length, b.length, 1);
}

export async function deleteFile(tools: WorkspaceTools, raw: unknown): Promise<FileChange> {
  const input = DeleteInput.parse(raw);
  const file = await tools.jail.resolve(input.path);
  await tools.assertVisible(file);
  const buffer = await fs.readFile(file);
  const decoded = decodeText(buffer);
  await fs.rm(file);
  return {
    path: tools.jail.relative(file),
    before: decoded.text,
    after: null,
    diff: unifiedDiff(decoded.text, '', input.path),
  };
}
export async function moveFile(
  tools: WorkspaceTools,
  raw: unknown,
): Promise<{ from: string; to: string }> {
  const input = PathPairInput.parse(raw);
  const from = await tools.jail.resolve(input.from);
  const to = await tools.jail.resolve(input.to, { allowMissing: true });
  await tools.assertVisible(from);
  await tools.assertVisible(to);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  return { from: tools.jail.relative(from), to: tools.jail.relative(to) };
}
export async function applyPatch(tools: WorkspaceTools, raw: unknown): Promise<FileChange[]> {
  const input = PatchInput.parse(raw);
  const lines = input.patch.split(/\r?\n/);
  const changes: FileChange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const oldHeader = lines[i];
    if (!oldHeader?.startsWith('--- ')) continue;
    const oldLine = oldHeader.slice(4);
    const nextHeader = lines[i + 1];
    i++;
    const newLine = nextHeader?.slice(4);
    if (!newLine) throw new Error('Malformed unified diff headers');
    const isNew = oldLine === '/dev/null';
    const isDeleted = newLine === '/dev/null';
    const target = newLine.replace(/^b\//, '').replace(/^\/dev\/null$/, '');
    const source = oldLine.replace(/^a\//, '');
    let current = '';
    if (!isNew) {
      const sourcePath = await tools.jail.resolve(source);
      await tools.assertVisible(sourcePath);
      current = decodeText(await fs.readFile(sourcePath)).text;
    }
    if (!isDeleted)
      await tools.assertVisible(await tools.jail.resolve(target, { allowMissing: true }));
    const original = current.split(/\r\n|\n|\r/);
    const result: string[] = [];
    let cursor = 0;
    while (i + 1 < lines.length && !lines[i + 1]?.startsWith('--- ')) {
      const hunk = lines[i + 1];
      if (hunk === undefined) break;
      i++;
      if (!hunk.startsWith('@@')) continue;
      const range = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk);
      if (!range) throw new Error('Malformed unified diff hunk');
      const oldStart = Number(range[1]);
      const hunkStart = Math.max(0, oldStart - 1);
      result.push(...original.slice(cursor, hunkStart));
      cursor = hunkStart;
      while (
        i + 1 < lines.length &&
        !lines[i + 1]?.startsWith('@@') &&
        !lines[i + 1]?.startsWith('--- ')
      ) {
        const row = lines[i + 1];
        if (row === undefined) break;
        i++;
        if (row.startsWith(' ')) {
          if (original[cursor] !== row.slice(1)) throw new Error('Patch context mismatch');
          result.push(row.slice(1));
          cursor++;
        } else if (row.startsWith('-')) {
          if (original[cursor] !== row.slice(1)) throw new Error('Patch context mismatch');
          cursor++;
        } else if (row.startsWith('+')) result.push(row.slice(1));
      }
    }
    result.push(...original.slice(cursor));
    const output = result.join('\n');
    if (isDeleted) {
      changes.push(await deleteFile(tools, { path: source }));
    } else {
      changes.push(await tools.writeFile({ path: target, content: output }));
    }
  }
  return changes;
}
