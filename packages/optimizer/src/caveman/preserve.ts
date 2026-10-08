// Adapted from OmniRoute preservation.ts and toolResultCompressor.ts (MIT),
// Copyright (c) 2026 diegosouzapw.
export interface PreservedSpan {
  start: number;
  end: number;
}

export function isCodeLikeLine(rawLine: string): boolean {
  const line = rawLine.trimStart();
  return (
    /^(?:import |export |function |class |const |let |var |return |if\s*\(|for\s*\(|while\s*\(|def |from |async |public |private |SELECT\b|INSERT\b|CREATE\b)/i.test(
      line,
    ) || /(?:=>|[{};]\s*$|^[\w.$]+\s*=)/.test(line)
  );
}

/** RTK/filters own code, logs, diffs, JSON, and shell output. */
export function isCodeLike(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  return (
    /^\s*[{[]/.test(text) ||
    /^(?:diff --git|@@|\+\+\+|--- a\/|\s*at\s+\S|\s*Traceback|\s*\d{4}-\d\d-\d\d|\s*\[(?:INFO|WARN|ERROR|DEBUG)\]|\s*(?:INFO|WARN|ERROR|DEBUG)\b|\s*(?:PS [^>]+>|\$ |npm |pnpm |git |node |python |curl ))/m.test(
      text,
    ) ||
    text.includes('\u001b[') ||
    (lines.length > 0 && lines.filter(isCodeLikeLine).length / lines.length >= 0.3)
  );
}

const patterns: readonly RegExp[] = [
  /<(?:system-reminder|instructions?|project-instructions?)>[\s\S]*?<\/(?:system-reminder|instructions?|project-instructions?)>/g,
  /`+[^`\n]*`+/g,
  /\[[^\]\n]+\]\([^)\n]+\)/g,
  /\bhttps?:\/\/[^\s)\]"'>]+/gi,
  /(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"`|]+/g,
  /(?:[A-Za-z]:[\\/]|\\\\)[^\n<>"`|]+/g,
  /(?:^|(?<=[\s("']))(?:\.{0,2}\/|~\/)[^\s<>"`|,)]+/gm,
  /\b[\w@.-]+(?:\/[\w@.-]+)+\b/g,
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|css|html|txt|yaml|yml|sh|ps1|toml)\b/gi,
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|Error|Exception):[^\n]*/g,
  /\b\d+(?:[.,:/-]\d+)*(?:%|[A-Za-z]+)?\b/g,
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?/g,
  /\b[A-Za-z_$][\w$]*\([^()\n]*\)/g,
  /\b\w*[_$]\w+\b/g,
  /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g,
  /\b[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g,
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\\n])*'/g,
  /^#{1,6}\s+.*$|^\s*\|.*\|\s*$/gm,
  /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g,
  /^(?:\s*(?:\$ |PS [^>]+>|npm |pnpm |git |node |python |curl |at\s+\S|Traceback|File ").*|[+-].*)$/gm,
  /\b(?:npm|pnpm|npx|git|node|python|python3|curl|echo|printf|cat|ls|mkdir|rm|rg|sed|awk|Get-Content|Set-Content|Remove-Item|Get-ChildItem|Write-Output)\s+[^\n]+/g,
];

/** Collect offsets rather than random sentinels; cache keys remain deterministic. */
export function preservedSpans(text: string): PreservedSpan[] {
  const spans: PreservedSpan[] = [];
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  let offset = 0;
  let fence: { char: string; length: number; start: number } | undefined;
  for (const line of lines) {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(line);
    const marker = match?.[1];
    if (fence) {
      if (marker?.[0] === fence.char && marker.length >= fence.length && !match?.[2]?.trim()) {
        spans.push({ start: fence.start, end: offset + line.length });
        fence = undefined;
      }
    } else if (marker) {
      fence = { char: marker[0] ?? '', length: marker.length, start: offset };
    }
    offset += line.length;
  }
  if (fence) throw new Error('Unclosed markdown fence');
  // Inline code and links are opaque even if they contain braces.
  for (const pattern of patterns.slice(0, 3)) {
    for (const match of text.matchAll(pattern))
      spans.push({ start: match.index, end: match.index + match[0].length });
  }
  // Preserve even nested/multiline JSON objects and arrays, including malformed
  // ones: an unmatched delimiter fails open for the whole input.
  const opaqueSpans = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  let opaqueIndex = 0;
  const stack: string[] = [];
  let jsonStart = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    while (opaqueSpans[opaqueIndex] && (opaqueSpans[opaqueIndex]?.end ?? 0) <= index)
      opaqueIndex += 1;
    const nextOpaque = opaqueSpans[opaqueIndex];
    const opaque = nextOpaque && index >= nextOpaque.start ? nextOpaque : undefined;
    if (jsonStart < 0 && opaque) {
      index = opaque.end - 1;
      continue;
    }
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{' || char === '[') {
      if (!stack.length) jsonStart = index;
      stack.push(char);
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) throw new Error('Unbalanced block');
      if (!stack.length) {
        spans.push({ start: jsonStart, end: index + 1 });
        jsonStart = -1;
      }
    }
  }
  if (stack.length) throw new Error('Unclosed block');
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern))
      spans.push({ start: match.index, end: match.index + match[0].length });
  }
  offset = 0;
  for (const line of lines) {
    if (isCodeLikeLine(line)) spans.push({ start: offset, end: offset + line.length });
    offset += line.length;
  }
  const merged: PreservedSpan[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}
