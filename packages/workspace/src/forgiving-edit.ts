import DiffMatchPatch from 'diff-match-patch';

export interface ForgivingEditMatch {
  start: number;
  end: number;
  count: number;
  snippet: string;
}
export interface ForgivingEditResult {
  match?: ForgivingEditMatch;
  disproportionate: boolean;
}
type Normalizer = (value: string) => string;
const normalizers: Normalizer[] = [
  (value) =>
    value
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .join('\n'),
  (value) =>
    value
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => line.trim())
      .join('\n'),
  (value) => value.replace(/\s+/g, ' ').trim(),
  (value) => value.replace(/^\s+/gm, '').replace(/\s+/g, ' ').trim(),
  (value) =>
    value
      .replace(
        /\\([nrt])/g,
        (_match, code: string) => ({ n: '\n', r: '\r', t: '\t' })[code] ?? code,
      )
      .replace(/\s+/g, ' ')
      .trim(),
  (value) => value.trim().replace(/\s+/g, ' '),
];

export function findForgivingEdit(text: string, search: string): ForgivingEditMatch | undefined {
  return findForgivingEditResult(text, search).match;
}

export function findForgivingEditResult(text: string, search: string): ForgivingEditResult {
  if (!search) return { disproportionate: false };
  const exactPositions = occurrences(text, search);
  if (exactPositions.length === 1)
    return {
      match: makeMatch(text, exactPositions[0] ?? 0, search.length, 1),
      disproportionate: false,
    };
  if (exactPositions.length > 1)
    return {
      match: makeMatch(text, exactPositions[0] ?? 0, search.length, exactPositions.length),
      disproportionate: false,
    };
  let disproportionate = false;
  const lineTrimmed = normalizers[0];
  if (lineTrimmed) {
    const needle = lineTrimmed(search);
    const mapped = normalizeWithOffsets(text, lineTrimmed);
    const startIndex = mapped.value.indexOf(needle);
    if (needle && startIndex >= 0) {
      const another = mapped.value.indexOf(needle, startIndex + needle.length);
      const start = mapped.offsets[startIndex] ?? 0;
      const last = mapped.offsets[startIndex + needle.length - 1] ?? start;
      const match = makeMatch(text, start, last + 1 - start, another < 0 ? 1 : 2);
      if (!isDisproportionate(match, search)) return { match, disproportionate };
      disproportionate = true;
    }
  }
  const anchorResult = findBlockAnchor(text, search);
  if (anchorResult.match) return { ...anchorResult, disproportionate };
  disproportionate ||= anchorResult.disproportionate;
  for (const normalize of normalizers.slice(1)) {
    const needle = normalize(search);
    if (!needle) continue;
    const mapped = normalizeWithOffsets(text, normalize);
    const startIndex = mapped.value.indexOf(needle);
    if (startIndex < 0) continue;
    const another = mapped.value.indexOf(needle, startIndex + needle.length);
    const start = mapped.offsets[startIndex] ?? 0;
    const last = mapped.offsets[startIndex + needle.length - 1] ?? start;
    const match = makeMatch(text, start, last + 1 - start, another < 0 ? 1 : 2);
    if (!isDisproportionate(match, search)) return { match, disproportionate };
    disproportionate = true;
  }
  const matcher = new DiffMatchPatch();
  matcher.Match_Threshold = 0.4;
  matcher.Match_Distance = 1000;
  // diff-match-patch throws "Pattern too long" past Match_MaxBits (32) characters: locate the
  // block by its opening characters, then require the whole snippet to be similar below.
  const probe = search.slice(0, Math.max(1, matcher.Match_MaxBits || 32));
  let location = -1;
  try {
    location = matcher.match_main(text, probe, 0);
  } catch {
    location = -1;
  }
  if (location >= 0) {
    const snippet = text.slice(location, location + search.length);
    const match = makeMatch(text, location, snippet.length, 1);
    if (textSimilarity(search, snippet) >= 0.55 && !isDisproportionate(match, search))
      return { match, disproportionate };
  }
  return { disproportionate };
}

function findBlockAnchor(text: string, search: string): ForgivingEditResult {
  const lines = search
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return { disproportionate: false };
  const first = escapeRegExp(lines[0] ?? '');
  const last = escapeRegExp(lines.at(-1) ?? '');
  const matches = [...text.matchAll(new RegExp(first + '[\\s\\S]*?' + last, 'g'))];
  const match = matches[0];
  if (match?.index === undefined || matches.length !== 1) return { disproportionate: false };
  const result = makeMatch(text, match.index, match[0].length, 1);
  return isDisproportionate(result, search)
    ? { disproportionate: true }
    : { match: result, disproportionate: false };
}

function occurrences(text: string, needle: string): number[] {
  const result: number[] = [];
  let from = 0;
  while ((from = text.indexOf(needle, from)) !== -1) {
    result.push(from);
    from += 1;
  }
  return result;
}
function isDisproportionate(match: ForgivingEditMatch, search: string): boolean {
  const length = match.end - match.start;
  return length > Math.max(search.length * 2.5, search.length + 80);
}
function makeMatch(text: string, start: number, length: number, count: number): ForgivingEditMatch {
  return { start, end: start + length, count, snippet: text.slice(start, start + length) };
}
function normalizeWithOffsets(
  text: string,
  normalize: Normalizer,
): { value: string; offsets: number[] } {
  const value = normalize(text);
  const offsets: number[] = [];
  let cursor = 0;
  for (const character of value) {
    if (/\s/.test(character)) {
      while (cursor < text.length && !/\s/.test(text[cursor] ?? '')) cursor++;
      offsets.push(cursor);
      while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor++;
    } else {
      const found = text.indexOf(character, cursor);
      const index = found < 0 ? cursor : found;
      offsets.push(index);
      cursor = index + 1;
    }
  }
  return { value, offsets };
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&');
}
function textSimilarity(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++)
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    previous = current;
  }
  return 1 - (previous[right.length] ?? 0) / Math.max(left.length, right.length, 1);
}

export function editRepairHint(text: string, search: string): string {
  const target = search.trim().split(/\r?\n/).find(Boolean) ?? search;
  const lines = text.split(/\r\n|\r|\n/);
  let closest = lines[0] ?? '';
  let best = -1;
  for (const line of lines) {
    const score = lineSimilarity(line.trim(), target.trim());
    if (score > best) {
      closest = line;
      best = score;
    }
  }
  const visible = closest.replace(/ /g, '·').replace(/\t/g, '→');
  return (
    'Edit block could not be matched. Closest actual line (spaces shown as ·, tabs as →): ' +
    visible +
    '. Re-read this region and retry with the current text.'
  );
}
function lineSimilarity(left: string, right: string): number {
  if (!left && !right) return 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++)
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    previous = current;
  }
  return 1 - (previous[right.length] ?? 0) / Math.max(left.length, right.length, 1);
}
