import { stripVTControlCharacters } from 'node:util';

export interface OpencodeAuthRecord {
  providerId: string;
  type: string | null;
  /** Raw credential; must never be logged or persisted. */
  key: string | null;
}

/** Parse the structural `opencode` auth store. The caller decides whether to fingerprint keys. */
export function parseOpencodeAuthStore(raw: unknown): OpencodeAuthRecord[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const records: OpencodeAuthRecord[] = [];
  for (const [providerId, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    records.push({
      providerId,
      type: typeof entry.type === 'string' ? entry.type : null,
      key: typeof entry.key === 'string' && entry.key ? entry.key : null,
    });
  }
  return records;
}

export interface OpencodeModelBlock {
  providerId: string;
  id: string;
  raw: Record<string, unknown>;
}

const modelHeader = /^([a-z0-9][a-z0-9._-]*)\/(\S+)\s*$/;

/**
 * Parse `opencode models --verbose` (a `provider/model` header line followed by a pretty-printed
 * JSON object per model). Tolerates ANSI output and unknown fields.
 */
export function parseOpencodeModelsVerbose(text: string): OpencodeModelBlock[] {
  const lines = stripVTControlCharacters(text).split(/\r?\n/);
  const blocks: OpencodeModelBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const header = modelHeader.exec(line.trim());
    if (!header || !lines[index + 1]?.trim().startsWith('{')) continue;
    let depth = 0;
    let json = '';
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const current = lines[cursor] ?? '';
      json += `${current}\n`;
      for (const character of current) {
        if (character === '{') depth += 1;
        else if (character === '}') depth -= 1;
      }
      if (depth === 0) break;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const raw = parsed as Record<string, unknown>;
        const id = typeof raw.id === 'string' && raw.id ? raw.id : (header[2] ?? '');
        blocks.push({ providerId: header[1] ?? '', id, raw });
      }
    } catch {
      /* skip malformed block, discovery remains best-effort */
    }
    index = cursor;
  }
  return blocks;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  authMethod: string | null;
  apiProvider: string | null;
  /** Non-null when the active credential comes from an API key/console source rather than OAuth. */
  apiKeySource: string | null;
}

/** Parse `claude auth status --json` defensively; the CLI also emits JSON without the flag. */
export function parseClaudeAuthStatus(text: string): ClaudeAuthStatus | null {
  try {
    const parsed: unknown = JSON.parse(stripVTControlCharacters(text).trim());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.loggedIn !== 'boolean') return null;
    return {
      loggedIn: value.loggedIn,
      email: typeof value.email === 'string' ? value.email : null,
      orgId: typeof value.orgId === 'string' ? value.orgId : null,
      orgName: typeof value.orgName === 'string' ? value.orgName : null,
      subscriptionType: typeof value.subscriptionType === 'string' ? value.subscriptionType : null,
      authMethod: typeof value.authMethod === 'string' ? value.authMethod : null,
      apiProvider: typeof value.apiProvider === 'string' ? value.apiProvider : null,
      apiKeySource: typeof value.apiKeySource === 'string' ? value.apiKeySource : null,
    };
  } catch {
    return null;
  }
}
