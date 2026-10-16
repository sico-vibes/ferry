import { expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OpenCodeAcpError,
  mapOpenCodeUsage,
  parseOpenCodeModelRef,
  runOpenCodeAcp,
} from '../src/index.js';

vi.setConfig({ testTimeout: 30_000 });

const executable = process.execPath;
const fixture = fileURLToPath(new URL('./fixtures/opencode-acp.mjs', import.meta.url));
const fixturesDir = dirname(fixture);
const environment = { ...process.env, XDG_DATA_HOME: fixturesDir, OPENCODE_API_KEY: '' };
const base = {
  model: 'opencode-go/deepseek-v4.1-flash',
  executable,
  executableArgs: [fixture],
  environment,
  credentialMode: 'installed' as const,
};
const signal = () => AbortSignal.timeout(10_000);

it('parses model refs and maps nullable usage dimensions', () => {
  expect(parseOpenCodeModelRef('opencode-go/deepseek-v4.1-flash')).toEqual({
    providerId: 'opencode-go',
    modelId: 'deepseek-v4.1-flash',
  });
  expect(parseOpenCodeModelRef('noslash')).toBeNull();
  expect(parseOpenCodeModelRef('/missing-provider')).toBeNull();
  expect(
    mapOpenCodeUsage({
      inputTokens: 0,
      outputTokens: 2,
      cachedReadTokens: 1,
      cachedWriteTokens: 2,
      thoughtTokens: 0,
    }),
  ).toEqual({ inputTokens: 0, outputTokens: 2, cachedTokens: 3, reasoningTokens: 0 });
  expect(mapOpenCodeUsage(null)).toEqual({
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
});

it('selects the exact model and applies only advertised variant/speed options', async () => {
  const result = await runOpenCodeAcp({
    ...base,
    prompt: 'go',
    variant: 'high',
    speed: 'fast',
    signal: signal(),
  });
  expect(result.responseModel).toBe('opencode-go/deepseek-v4.1-flash');
  expect(result.text).toContain('CONFIG|opencode-go/deepseek-v4.1-flash|high|fast');
  expect(result.usage).toEqual({
    inputTokens: 12,
    outputTokens: 2,
    cachedTokens: null,
    reasoningTokens: null,
  });
  const standard = await runOpenCodeAcp({
    ...base,
    prompt: 'go',
    variant: 'low',
    speed: 'standard',
    signal: signal(),
  });
  expect(standard.text).toContain('|low|standard|');
});

it('rejects an unavailable model before prompting without a paid default', async () => {
  const rejected = runOpenCodeAcp({
    ...base,
    model: 'paid/expensive-model',
    prompt: 'go',
    signal: signal(),
  });
  await expect(rejected).rejects.toBeInstanceOf(OpenCodeAcpError);
  await expect(rejected).rejects.toMatchObject({ category: 'model_unavailable' });
  await expect(rejected).rejects.toThrow(/No fallback/);
});

it('rejects an unadvertised variant before prompting', async () => {
  const rejected = runOpenCodeAcp({ ...base, prompt: 'go', variant: 'ultra', signal: signal() });
  await expect(rejected).rejects.toMatchObject({ category: 'unsupported_option' });
});

it('works anonymously even when a native key is present, stripping provider keys', async () => {
  const result = await runOpenCodeAcp({
    ...base,
    environment: { ...environment, OPENCODE_API_KEY: 'native-secret' },
    credentialMode: 'anonymous',
    prompt: 'go',
    signal: signal(),
  });
  expect(result.text).toContain('|nokey|private|');
});

it('uses only the explicit Ferry key in ferry mode inside a private data root', async () => {
  const result = await runOpenCodeAcp({
    ...base,
    apiKey: 'ferry-secret',
    credentialMode: 'ferry',
    prompt: 'go',
    signal: signal(),
  });
  expect(result.text).toContain('|key|private|');
});

function authHome(records: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-oc-auth-'));
  mkdirSync(join(dir, 'opencode'), { recursive: true });
  writeFileSync(join(dir, 'opencode', 'auth.json'), JSON.stringify(records), 'utf8');
  return dir;
}

const cleanup = (path: string): void => {
  rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
};

it('pins an offered native Go credential to the actual Zen provider via the config override', async () => {
  const home = authHome({
    opencode: { type: 'api', key: 'zen-A' },
    'opencode-go': { type: 'api', key: 'go-B' },
  });
  try {
    const result = await runOpenCodeAcp({
      ...base,
      model: 'opencode/big-pickle',
      credentialProvider: 'opencode-go',
      environment: {
        ...environment,
        XDG_DATA_HOME: home,
        OPENCODE_API_KEY: 'env-C',
        FERRY_OC_EXPECT_KEY: 'go-B',
      },
      prompt: 'go',
      signal: signal(),
    });
    expect(result.responseModel).toBe('opencode/big-pickle');
    // The offered Go key is pinned to the Zen provider; a native Zen key A and env C cannot override
    // it. The env fallback is removed for this path, so only the config override carries the key.
    expect(result.text).toContain('|nokey|native|');
    expect(result.text).toContain('opencode,opencode-go');
    expect(result.text).toContain('|src:config|');
    expect(result.text).toContain('|match:yes');
  } finally {
    cleanup(home);
  }
});

it('honors a caller-captured installed key instead of rereading a changed native store', async () => {
  const home = authHome({ 'opencode-go': { type: 'api', key: 'changed-C' } });
  try {
    const result = await runOpenCodeAcp({
      ...base,
      model: 'opencode/big-pickle',
      credentialProvider: 'opencode-go',
      apiKey: 'captured-B',
      environment: {
        ...environment,
        XDG_DATA_HOME: home,
        OPENCODE_API_KEY: 'env-C',
        FERRY_OC_EXPECT_KEY: 'captured-B',
      },
      prompt: 'go',
      signal: signal(),
    });
    expect(result.text).toContain('|src:config|');
    expect(result.text).toContain('|match:yes');
    expect(result.text).not.toContain('changed-C');
    expect(result.text).not.toContain('env-C');
  } finally {
    cleanup(home);
  }
});

it('reflects native same-provider precedence (installed store key beats env)', async () => {
  const home = authHome({ opencode: { type: 'api', key: 'zen-A' } });
  try {
    const result = await runOpenCodeAcp({
      ...base,
      model: 'opencode/big-pickle',
      environment: {
        ...environment,
        XDG_DATA_HOME: home,
        OPENCODE_API_KEY: 'env-C',
        FERRY_OC_EXPECT_KEY: 'zen-A',
      },
      prompt: 'go',
      signal: signal(),
    });
    // Same-provider runs inject nothing: the child applies the native store-over-env precedence.
    expect(result.text).toContain('|key|native|');
    expect(result.text).toContain('|src:store|');
    expect(result.text).toContain('|match:yes');
    expect(result.text).not.toContain('|src:config|');
  } finally {
    cleanup(home);
  }
});

it('rejects an unapproved cross-provider offer before reading any credential', async () => {
  const home = authHome({ anthropic: { type: 'api', key: 'anthropic-secret' } });
  try {
    await expect(
      runOpenCodeAcp({
        ...base,
        model: 'opencode/big-pickle',
        credentialProvider: 'anthropic',
        environment: { ...environment, XDG_DATA_HOME: home },
        prompt: 'go',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ category: 'credential' });
    // A Go model receiving a Zen offer is not the approved direction either.
    await expect(
      runOpenCodeAcp({
        ...base,
        model: 'opencode-go/deepseek-v4.1-flash',
        credentialProvider: 'opencode',
        environment: { ...environment, XDG_DATA_HOME: home },
        prompt: 'go',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ category: 'credential' });
  } finally {
    cleanup(home);
  }
});

it('never copies an OAuth record as an offered API key', async () => {
  const home = authHome({ 'opencode-go': { type: 'oauth', key: 'oauth-stray', refresh: 'r' } });
  try {
    await expect(
      runOpenCodeAcp({
        ...base,
        model: 'opencode/big-pickle',
        credentialProvider: 'opencode-go',
        environment: { ...environment, XDG_DATA_HOME: home },
        prompt: 'go',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ category: 'credential' });
  } finally {
    cleanup(home);
  }
});

it('rejects anonymous mode combined with an explicit provider entry', async () => {
  await expect(
    runOpenCodeAcp({
      ...base,
      credentialProvider: 'opencode-go',
      credentialMode: 'anonymous',
      prompt: 'go',
      signal: signal(),
    }),
  ).rejects.toMatchObject({ category: 'credential' });
});

it('reports an unavailable approved Go offer instead of falling back', async () => {
  await expect(
    runOpenCodeAcp({
      ...base,
      model: 'opencode/big-pickle',
      credentialProvider: 'opencode-go',
      environment: {
        ...environment,
        XDG_DATA_HOME: join(fixturesDir, 'nonexistent-data'),
        OPENCODE_API_KEY: '',
      },
      prompt: 'go',
      signal: signal(),
    }),
  ).rejects.toMatchObject({ category: 'credential' });
});

it('round-trips a caller tool call using the real ACP tool-use id, then accepts the result', async () => {
  const tools = [
    { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  ];
  const result = await runOpenCodeAcp({ ...base, tools, prompt: 'use a tool', signal: signal() });
  expect(result.toolCalls).toEqual([
    { id: 'acp-tool-1', name: 'read_file', arguments: { path: 'marker.txt' } },
  ]);
  expect(result.usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
  const continued = await runOpenCodeAcp({
    ...base,
    tools,
    prompt: 'TOOL_RESULT',
    signal: signal(),
  });
  expect(continued.text).toContain('TOOL_RESULT');
});

it('rejects native reads, writes and shell approval', async () => {
  const result = await runOpenCodeAcp({ ...base, prompt: 'NATIVE_DENIAL', signal: signal() });
  expect(result.text).toBe('DENIED');
});

it('preserves missing vs reported-zero vs partial usage dimensions', async () => {
  const omitted = await runOpenCodeAcp({ ...base, prompt: 'OMIT_USAGE', signal: signal() });
  expect(omitted.usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
  const zero = await runOpenCodeAcp({ ...base, prompt: 'ZERO_USAGE', signal: signal() });
  expect(zero.usage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  });
  const partial = await runOpenCodeAcp({ ...base, prompt: 'PARTIAL_USAGE', signal: signal() });
  expect(partial.usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    cachedTokens: 3,
    reasoningTokens: null,
  });
});

it('streams multi-byte UTF-8 text without corruption', async () => {
  const chunks: string[] = [];
  const result = await runOpenCodeAcp({
    ...base,
    prompt: 'NONASCII',
    signal: signal(),
    onText: (chunk) => chunks.push(chunk),
  });
  expect(result.text).toBe('héllo‑世界🌈');
  expect(chunks.join('')).toBe('héllo‑世界🌈');
});

it('cancels an in-flight request and releases the subprocess', async () => {
  const controller = new AbortController();
  const pending = runOpenCodeAcp({ ...base, prompt: 'HOLD', signal: controller.signal });
  controller.abort(new Error('fixture cancelled'));
  await expect(pending).rejects.toThrow('fixture cancelled');
});

it('deletes only its own native session in installed mode and not in anonymous mode', async () => {
  const marker = join(tmpdir(), `ferry-oc-delete-${randomUUID()}.txt`);
  try {
    await runOpenCodeAcp({
      ...base,
      environment: { ...environment, FERRY_OC_DELETE_MARKER: marker },
      prompt: 'go',
      signal: signal(),
    });
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('oc-acp-session');

    rmSync(marker, { force: true });
    await runOpenCodeAcp({
      ...base,
      environment: { ...environment, FERRY_OC_DELETE_MARKER: marker },
      credentialMode: 'anonymous',
      prompt: 'go',
      signal: signal(),
    });
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(marker, { force: true });
  }
});

it('pins PWD to the private cwd and never imports the parent project config, rules or plugins', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ferry-oc-parent-'));
  try {
    // A hostile orchestrator checkout: project config, rules and a plugin that would run on load.
    const sentinel = join(parent, 'plugin-ran.txt');
    mkdirSync(join(parent, '.opencode', 'plugin'), { recursive: true });
    writeFileSync(
      join(parent, 'opencode.json'),
      JSON.stringify({ plugin: ['./.opencode/plugin/evil.mjs'], mcp: { evil: { type: 'local' } } }),
      'utf8',
    );
    writeFileSync(join(parent, 'AGENTS.md'), 'MALICIOUS_RULE', 'utf8');
    writeFileSync(
      join(parent, '.opencode', 'plugin', 'evil.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`,
      'utf8',
    );
    const opencodeJson = readFileSync(join(parent, 'opencode.json'), 'utf8');

    const result = await runOpenCodeAcp({
      ...base,
      environment: {
        ...environment,
        PWD: parent,
        OPENCODE_CONFIG: join(parent, 'opencode.json'),
        OPENCODE_CONFIG_DIR: join(parent, '.opencode'),
      },
      prompt: 'go',
      signal: signal(),
    });

    // The transport rewrote the leaky variables: PWD is the private cwd, project config discovery
    // is off, and the inherited config-file pointers are gone. The plugin never executed.
    expect(result.text).toContain('pwd-private');
    expect(result.text).toContain('proj-off');
    expect(result.text).toContain('config-env-off');
    expect(existsSync(sentinel)).toBe(false);
    // Nothing on disk in the parent checkout is mutated.
    expect(readFileSync(join(parent, 'opencode.json'), 'utf8')).toBe(opencodeJson);
    expect(existsSync(join(parent, 'AGENTS.md'))).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it('keeps text-only output and separate reasoning without folding or inventing totals', async () => {
  // Mirrors the live Go HIGH probe: text-only output counter (9/12) plus a separate reasoning
  // counter (307/41); the CLI reports no cache dimensions, so cache stays null.
  const high = await runOpenCodeAcp({ ...base, prompt: 'GO_HIGH', signal: signal() });
  expect(high.text).toBe('NATIVE_TOOLS_UNAVAILABLE');
  expect(high.usage).toEqual({
    inputTokens: 12776,
    outputTokens: 9,
    cachedTokens: null,
    reasoningTokens: 307,
  });

  const continued = await runOpenCodeAcp({ ...base, prompt: 'GO_HIGH_CONTINUE', signal: signal() });
  expect(continued.usage).toEqual({
    inputTokens: 12953,
    outputTokens: 12,
    cachedTokens: null,
    reasoningTokens: 41,
  });
});
