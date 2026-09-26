import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadCatalog } from '@ferry/catalog';
import type { ProviderErrorKind } from '@ferry/shared';
import type { ProbeResult } from '@ferry/shared';
import { probe } from './index.js';

export interface LiveProbeCapture {
  url: string;
  status: number;
  headers: Record<string, string>;
}

export interface LiveProbeRow {
  provider: string;
  ok: boolean;
  model: string | null;
  skipped: { model: string; reason: string }[];
  windows: ProbeResult['windows'];
  errorKind: ProviderErrorKind | null;
  message: string;
}

export async function runLiveProbe(options: {
  keys: Record<string, string | undefined>;
  baseUrls?: Record<string, string | undefined>;
  outputDirectory: string;
  fetch?: typeof globalThis.fetch;
  write?: (provider: string, fixture: unknown) => Promise<void>;
  print?: (line: string) => void;
}): Promise<LiveProbeRow[]> {
  const catalog = await loadCatalog();
  if (!options.write) await mkdir(options.outputDirectory, { recursive: true });
  const rows: LiveProbeRow[] = [];
  for (const provider of catalog.providers) {
    const key = options.keys[provider.provider] ?? '';
    if (!key && provider.key_required !== false) continue;
    const captures: LiveProbeCapture[] = [];
    const recordingFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await (options.fetch ?? globalThis.fetch)(input, init);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() === 'retry-after' || name.toLowerCase().startsWith('x-ratelimit-'))
          headers[name.toLowerCase()] = value;
      });
      const url = input instanceof Request ? input.url : String(input);
      captures.push({ url: url.replace(/\?.*$/, ''), status: response.status, headers });
      return response;
    };
    const baseUrl =
      options.baseUrls?.[provider.provider] ??
      (provider.provider === 'openrouter'
        ? 'https://openrouter.ai/api/v1'
        : provider.provider === 'gemini'
          ? 'https://generativelanguage.googleapis.com/v1beta/openai'
          : undefined);
    const result = await probe(provider.provider, key, {
      fetch: recordingFetch,
      ...(baseUrl ? { baseUrl } : {}),
      timeoutMs: 60_000,
    });
    const model = result.usedModel ?? result.models[0] ?? null;
    const windows = result.windows;
    const row: LiveProbeRow = {
      provider: provider.provider,
      ok: result.ok,
      model,
      skipped: result.skippedModels ?? [],
      windows,
      errorKind: result.errorKind,
      message: result.message.replaceAll(key, key ? '[REDACTED]' : ''),
    };
    rows.push(row);
    const fixture = {
      provider: provider.provider,
      capturedAt: new Date().toISOString(),
      ok: result.ok,
      model,
      skipped: row.skipped,
      windows,
      errorKind: row.errorKind,
      message: row.message,
      calls: captures,
    };
    const secrets = Object.values(options.keys).filter((secret): secret is string =>
      Boolean(secret),
    );
    const redact = (value: unknown): unknown =>
      typeof value === 'string'
        ? secrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), value)
        : Array.isArray(value)
          ? value.map(redact)
          : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]))
            : value;
    const safeFixture = redact(fixture);
    if (options.write) await options.write(provider.provider, safeFixture);
    else
      await writeFile(
        join(options.outputDirectory, `${provider.provider}.json`),
        `${JSON.stringify(safeFixture, null, 2)}\n`,
        'utf8',
      );
    const printed = `${row.provider}\t${row.ok ? 'yes' : 'no'}\t${row.model ?? '-'}\t${JSON.stringify(row.skipped)}\t${JSON.stringify(row.windows)}\t${row.errorKind ?? row.message}`;
    options.print?.(
      secrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), printed),
    );
  }
  return rows;
}
