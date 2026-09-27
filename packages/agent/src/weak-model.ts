import { jsonrepair } from 'jsonrepair';
export interface ModelHints {
  toolProtocol?: 'native' | 'xml' | 'react' | 'none';
  editFormat?: string;
}
export interface TextToolCall {
  name: string;
  input: unknown;
}
export interface TextToolCallParseResult {
  calls: TextToolCall[];
  hints: string[];
}
export function parseTextToolCalls(
  text: string,
  toolNames: readonly string[],
  untrustedSources: readonly string[] = [],
): TextToolCall[] {
  return parseTextToolCallsDetailed(text, toolNames, untrustedSources).calls;
}
export function parseTextToolCallsDetailed(
  text: string,
  toolNames: readonly string[],
  untrustedSources: readonly string[] = [],
): TextToolCallParseResult {
  const calls: TextToolCall[] = [];
  const hints: string[] = [];
  const trimmed = text.trim();
  if (!trimmed || /^\s*>/m.test(text)) return { calls, hints };

  // A JSON fence is accepted only as the whole assistant message. XML/marker calls
  // inside arbitrary prose, markdown quotes, or code fences are never candidates.
  const fencedJson = /^```(?:json|tool_call)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const candidate = fencedJson?.[1]?.trim() ?? trimmed;
  const fromFence = fencedJson !== null;
  if (fromFence && !/^(?:\s*\{|\s*\[)/.test(candidate)) return { calls, hints };
  if (untrustedSources.some((source) => source.length > 0 && source.includes(candidate)))
    return { calls, hints };

  const functionPattern = /<function\s*=\s*["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/function>/gi;
  const functionMatches = [...candidate.matchAll(functionPattern)];
  const exactFunctionText =
    functionMatches.length > 0 && candidate.replace(functionPattern, '').trim() === '';
  if (exactFunctionText) {
    for (const match of functionMatches) {
      if (untrustedSources.some((source) => source.includes(match[0]))) continue;
      const name = resolveToolAlias(match[1] ?? '', toolNames);
      if (!name) continue;
      const parsed = safeParseArguments(match[2] ?? '');
      if (parsed.ok) calls.push({ name, input: parsed.value });
      else hints.push(`Malformed arguments for ${name}: ${parsed.hint}`);
    }
  } else if (!fromFence) {
    const inline = /^tool_call\s*:\s*([\w.-]+)\s*(\{[\s\S]*\})$/i.exec(candidate);
    const name = resolveToolAlias(inline?.[1] ?? '', toolNames);
    if (name && inline?.[2] && !untrustedSources.some((source) => source.includes(inline[0]))) {
      const parsed = safeParseArguments(inline[2]);
      if (parsed.ok) calls.push({ name, input: parsed.value });
      else hints.push(`Malformed arguments for ${name}: ${parsed.hint}`);
    }
  }

  if (candidate.startsWith('{') || candidate.startsWith('[')) {
    const parsed = safeParseArguments(candidate);
    if (!parsed.ok) {
      hints.push(`Malformed text tool call: ${parsed.hint}`);
    } else {
      const entries = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        if (appearsVerbatimInSources(entry, untrustedSources)) continue;
        const alias = entry.name ?? entry.tool;
        const resolved = resolveToolAlias(typeof alias === 'string' ? alias : '', toolNames);
        if (resolved)
          calls.push({
            name: resolved,
            input: entry.arguments ?? entry.input ?? entry.parameters ?? {},
          });
      }
    }
  }
  return {
    calls: [
      ...new Map(calls.map((call) => [JSON.stringify([call.name, call.input]), call])).values(),
    ],
    hints: [...new Set(hints)],
  };
}
function safeParseArguments(
  value: string,
): { ok: true; value: unknown } | { ok: false; hint: string } {
  try {
    return { ok: true, value: parseArguments(value) };
  } catch (error) {
    return { ok: false, hint: error instanceof Error ? error.message : String(error) };
  }
}
function parseArguments(value: string): unknown {
  const text = value.trim();
  if (!text) return {};
  if (/^<[\w.-]+>[\s\S]*<\/[\w.-]+>$/.test(text)) {
    const entries = [...text.matchAll(/<([\w.-]+)>([\s\S]*?)<\/\1>/g)];
    if (entries.length)
      return Object.fromEntries(entries.map((entry) => [entry[1] ?? '', entry[2] ?? '']));
  }
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(jsonrepair(escapePathBackslashes(text)));
  }
}
function escapePathBackslashes(text: string): string {
  return text
    .replace(
      /(["']?\b(?:path|file|filename|directory|dir)\b["']?\s*:\s*)(["'])([\s\S]*?)\2/gi,
      (_match, key: string, quote: string, value: string) =>
        key + quote + (isPathLike(value) ? doubleUnescapedBackslashes(value) : value) + quote,
    )
    .replace(
      /(["']?\b(?:path|file|filename|directory|dir)\b["']?\s*:\s*)([A-Za-z]:\\[^,}\s]+|\\\\[^,}\s]+)/gi,
      (_match, key: string, value: string) => key + doubleUnescapedBackslashes(value),
    );
}
function isPathLike(value: string): boolean {
  return /^[A-Za-z]:\\|^\\\\/.test(value);
}
function doubleUnescapedBackslashes(value: string): string {
  return value.replace(/\\+/g, (slashes, offset: number) => {
    if (offset === 0 && value.startsWith('\\\\') && slashes.length === 2) return '\\\\\\\\';
    return slashes.length % 2 === 1 ? slashes + '\\' : slashes;
  });
}
function resolveToolAlias(alias: string, names: readonly string[]): string | undefined {
  if (names.includes(alias)) return alias;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = names.find((name) => normalize(name) === normalize(alias));
  if (match) return match;
  const aliases: Record<string, string> = {
    readfile: 'read_file',
    writefile: 'write_file',
    editfile: 'edit_file',
    replaceinfile: 'edit_file',
    readoutput: 'read_output',
    listdirectory: 'list_dir',
  };
  const candidate = aliases[normalize(alias)];
  return candidate && names.includes(candidate) ? candidate : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function appearsVerbatimInSources(value: unknown, sources: readonly string[]): boolean {
  const serialized = JSON.stringify(value);
  const compactedValue = compactJsonWhitespace(serialized);
  return sources.some((source) => {
    if (source.includes(serialized) || compactJsonWhitespace(source).includes(compactedValue))
      return true;
    const parsed = safeParseArguments(source);
    return parsed.ok && containsEquivalentJsonValue(parsed.value, serialized);
  });
}
function compactJsonWhitespace(value: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
      result += character;
    } else if (!/\s/.test(character)) result += character;
  }
  return result;
}
function containsEquivalentJsonValue(value: unknown, serialized: string): boolean {
  if (JSON.stringify(value) === serialized) return true;
  if (Array.isArray(value))
    return value.some((entry) => containsEquivalentJsonValue(entry, serialized));
  return (
    isRecord(value) &&
    Object.values(value).some((entry) => containsEquivalentJsonValue(entry, serialized))
  );
}
export function containsOmissionPlaceholder(value: unknown): boolean {
  if (typeof value === 'string')
    return /(?:^|\n)\s*(?:\/\/|#|<!--)[^\r\n]*\b(?:rest of (?:the )?code|existing code|unchanged(?: code)?)\b[^\r\n]*(?:-->)?/i.test(
      value,
    );
  if (Array.isArray(value)) return value.some(containsOmissionPlaceholder);
  if (isRecord(value)) return Object.values(value).some(containsOmissionPlaceholder);
  return false;
}
export function toolCallFingerprint(name: string, input: unknown): string {
  return name + ':' + JSON.stringify(input);
}
export class ReflectionBudget {
  private used = 0;
  constructor(readonly maximum = 3) {}
  consume(): boolean {
    if (this.used >= this.maximum) return false;
    this.used++;
    return true;
  }
  get remaining(): number {
    return Math.max(0, this.maximum - this.used);
  }
}
export class ToolRepetitionDetector {
  private readonly counts = new Map<string, number>();
  observe(name: string, input: unknown): boolean {
    const key = toolCallFingerprint(name, input);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count >= 3;
  }
  reset(): void {
    this.counts.clear();
  }
}
