import { jsonrepair } from 'jsonrepair';
export interface ModelHints {
  toolProtocol?: 'native' | 'xml' | 'react' | 'none';
  editFormat?: string;
}
export interface TextToolCall {
  name: string;
  input: unknown;
}
export function parseTextToolCalls(text: string, toolNames: readonly string[]): TextToolCall[] {
  const calls: TextToolCall[] = [];
  const patterns = [
    /<function\s*=\s*["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/function>/gi,
    /<([\w.-]+)>([\s\S]*?)<\/\1>/g,
  ];
  const candidates: string[] = [];
  for (const fence of text.matchAll(/\x60{3}(?:json|tool_call|javascript)?\s*([\s\S]*?)\x60{3}/gi))
    candidates.push(fence[1] ?? '');
  for (const marker of text.matchAll(
    /(?:\[\[?tool_call\]?\]|<tool_call>|<\|tool_call_begin\|>)([\s\S]*?)(?:<\/tool_call>|<\|tool_call_end\|>|$)/gi,
  ))
    candidates.push(marker[1] ?? '');
  candidates.push(text);
  for (const candidate of candidates) {
    for (const pattern of patterns)
      for (const match of candidate.matchAll(pattern)) {
        const name = resolveToolAlias(match[1] ?? '', toolNames);
        if (name) calls.push({ name, input: parseArguments(match[2] ?? '') });
      }
    const inline = /(?:tool_call|to=)(?:\s*[:=]\s*|\s+)([\w.-]+)[\s\S]*?(\{[\s\S]*\})/i.exec(
      candidate,
    );
    const name = resolveToolAlias(inline?.[1] ?? '', toolNames);
    if (name && inline?.[2]) calls.push({ name, input: parseArguments(inline[2]) });
    try {
      const value = parseArguments(candidate);
      if (Array.isArray(value))
        for (const entry of value)
          if (isRecord(entry)) {
            const alias = entry.name ?? entry.tool;
            const resolved = resolveToolAlias(typeof alias === 'string' ? alias : '', toolNames);
            if (resolved)
              calls.push({
                name: resolved,
                input: entry.arguments ?? entry.input ?? entry.parameters ?? {},
              });
          }
      if (isRecord(value) && (value.name || value.tool)) {
        const alias = value.name ?? value.tool;
        const resolved = resolveToolAlias(typeof alias === 'string' ? alias : '', toolNames);
        if (resolved)
          calls.push({
            name: resolved,
            input: value.arguments ?? value.input ?? value.parameters ?? {},
          });
      }
    } catch {
      /* not a standalone call */
    }
  }
  return [
    ...new Map(calls.map((call) => [JSON.stringify([call.name, call.input]), call])).values(),
  ];
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
    return JSON.parse(jsonrepair(text));
  }
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
export function containsOmissionPlaceholder(value: unknown): boolean {
  if (typeof value === 'string')
    return /(?:\.\.\.|\/\/\s*(?:rest of (?:the )?code|existing code|unchanged code)|#\s*(?:rest of (?:the )?code|existing code))/i.test(
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
