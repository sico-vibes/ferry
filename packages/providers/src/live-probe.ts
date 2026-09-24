import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { loadCatalog } from '@ferry/catalog';
import { createLanguageModel } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(here, '..', 'test', 'fixtures', 'live');

function safeBody(text: string, key: string): unknown {
  if (!text) return null;
  try {
    return redact(JSON.parse(text) as unknown, key);
  } catch {
    return text.replaceAll(key, '[REDACTED]').slice(0, 4000);
  }
}

function redact(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => redact(entry, key));
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    return value.replaceAll(key, '[REDACTED]');
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      /key|token|secret|authorization|content|prompt|text/i.test(name)
        ? '[REDACTED]'
        : redact(entry, key),
    ]),
  );
}

export async function runLiveProbe(): Promise<void> {
  const catalog = await loadCatalog();
  await mkdir(outputDirectory, { recursive: true });

  for (const provider of catalog.providers) {
    const envName = `FERRY_KEY_${provider.provider.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
    const key = process.env[envName];
    if (!key) continue;
    const model = catalog.models.find((entry) => entry.providerId === provider.provider);
    if (!model) continue;
    const captures: {
      url: string;
      status: number;
      headers: Record<string, string>;
      body: unknown;
    }[] = [];
    const recordingFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() === 'retry-after' || name.toLowerCase().startsWith('x-ratelimit-')) {
          headers[name.toLowerCase()] = value;
        }
      });
      const url = input instanceof Request ? input.url : String(input);
      captures.push({
        url: url.replace(/\?.*$/, ''),
        status: response.status,
        headers,
        body: safeBody(await response.clone().text(), key),
      });
      return response;
    };
    let outcome: { ok: true; message: string } | { ok: false; error: string };
    try {
      const modelInstance = createLanguageModel(model.ref, {
        apiKey: key,
        sessionId: `live-probe-${String(Date.now())}`,
        fetch: recordingFetch,
      });
      await generateText({
        model: modelInstance,
        prompt: 'Reply with one character.',
        maxOutputTokens: 1,
      });
      outcome = { ok: true, message: 'Key valid' };
    } catch (error) {
      outcome = {
        ok: false,
        error: String(error instanceof Error ? error.message : error).replaceAll(key, '[REDACTED]'),
      };
    }
    const path = join(outputDirectory, `${provider.provider}.json`);
    await writeFile(
      path,
      `${JSON.stringify({ provider: provider.provider, model: model.ref, outcome, calls: captures }, null, 2)}\n`,
      'utf8',
    );
    console.log(`Wrote ${path}`);
  }
}
