// Explicit live operation; never imported by CI/tests. Credentials stay in memory and
// every external client gets a disposable HOME/config/workspace, even on Windows.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.includes('--help')) {
  console.log(
    'Usage: node --import tsx scripts/live/client-certification.mjs --live\nRequired env: FERRY_CERT_PROVIDER, FERRY_CERT_MODEL (free model ref), FERRY_CERT_KEY (isolated test key). Optional: FERRY_CERT_BASE_URL.\nRuns installed opencode/codex/claude and generic HTTP; never uses stored keys. Free-only.',
  );
} else {
  assert.ok(process.argv.includes('--live'), 'Explicit --live required');
  const provider = process.env.FERRY_CERT_PROVIDER,
    model = process.env.FERRY_CERT_MODEL,
    credential = process.env.FERRY_CERT_KEY;
  assert.ok(
    provider && model && credential,
    'Set the isolated test provider/model/key environment variables',
  );
  if (process.env.FERRY_CERT_BASE_URL) {
    let endpoint;
    try {
      endpoint = new URL(process.env.FERRY_CERT_BASE_URL);
    } catch {
      throw new Error('Invalid test endpoint; value withheld');
    }
    assert.ok(
      ['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password,
      'Test endpoint must use HTTP(S) without embedded credentials',
    );
  }
  const root = resolve(import.meta.dirname, '../..');
  const require = createRequire(join(root, 'apps/cli/package.json'));
  const load = (name) => import(pathToFileURL(require.resolve(name)).href);
  const { createCoreHost, createMemoryTransportPair } = await load('@ferry/core');
  const { createRpcFerryClient } = await load('@ferry/client');
  const { toolLaunch } = await load('@ferry/shared');
  const { toolProcess } = await load('@ferry/cli');
  const { detectCli } = await load('@ferry/delegate');
  const operatingSystemNames = new Set([
    'PATH',
    'PATHEXT',
    'COMSPEC',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'TEMP',
    'TMP',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'OS',
    'USERNAME',
    'USERDOMAIN',
    'COMPUTERNAME',
    'TERM',
    'LANG',
    'LC_ALL',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
  ]);
  const operatingSystemEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => operatingSystemNames.has(name.toUpperCase())),
  );
  const temporary = await mkdtemp(join(tmpdir(), 'ferry-live-clients-'));
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  let host, client;
  try {
    host = await createCoreHost({
      dataDir: join(temporary, 'core'),
      transport: coreTransport,
      env: {
        ...operatingSystemEnvironment,
        ...(process.env.FERRY_CERT_BASE_URL
          ? {
              [`FERRY_PROVIDER_BASE_URL_${provider.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`]:
                process.env.FERRY_CERT_BASE_URL,
            }
          : {}),
        NODE_ENV: 'test',
        FERRY_TEST_KEYRING_NAMESPACE: `ferry-client-cert-${randomUUID()}`,
        FERRY_KEYRING_SERVICE: `Ferry-Live-Cert-${randomUUID()}`,
      },
    });
    client = createRpcFerryClient(clientTransport, { timeoutMs: 60_000 });
    await client.hello;
    await client.providers.setKey(provider, credential);
    await client.providers.setEnabled(provider, true);
    const candidate = (await client.models.list(provider)).find((item) => item.ref === model);
    assert.ok(
      candidate?.providerId === provider && candidate.free && candidate.toolCalling,
      'Live certification requires a free, tool-capable discovered model',
    );
    const key = await client.gateway.createKey({
      name: 'Isolated live certification',
      profile: 'none',
    });
    await client.gateway.updateKey({ id: key.key.id, patch: { allowedModels: [model] } });
    const started = await client.gateway.setSettings({ enabled: true, port: 0, allowLan: false });
    const connection = { url: started.status.url, model, secret: key.secret };
    const nonce = `CERTIFIED_${randomUUID()}`;
    const prompt = `Read certification.txt with your file tool, then reply with its exact contents. Do not modify files or run commands.`;
    for (const tool of ['opencode', 'codex', 'claude']) {
      const home = join(temporary, tool);
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'certification.txt'), nonce, 'utf8');
      const args =
        tool === 'opencode'
          ? ['run', prompt]
          : tool === 'codex'
            ? ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', prompt]
            : ['-p', prompt, '--allowedTools', 'Read', '--max-turns', '3'];
      const launch = toolLaunch(tool, connection, args);
      const executable = await toolProcess(launch);
      const clientEnvironment = {
        ...operatingSystemEnvironment,
        HOME: home,
        USERPROFILE: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home,
        XDG_DATA_HOME: home,
        XDG_CACHE_HOME: home,
        CODEX_HOME: home,
        CLAUDE_CONFIG_DIR: home,
        ...launch.env,
      };
      const detected = await detectCli(tool, {
        checkAuth: false,
        cwd: home,
        environment: clientEnvironment,
      });
      assert.ok(detected.available, `${tool}: installed client detection failed`);
      const version = /\d+\.\d+(?:\.\d+)?/.exec(detected.version ?? '')?.[0] ?? 'unreported';
      console.log(`Installed ${tool} ${version}`);
      const output = await new Promise((resolveRun, reject) => {
        const child = spawn(executable.command, executable.args, {
          cwd: home,
          env: clientEnvironment,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let text = '';
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (chunk) => {
            text += chunk;
          });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`${tool}: deadline exceeded`));
        }, 120_000);
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error(`${tool}: launch failed`));
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          code === 0
            ? resolveRun(text)
            : reject(new Error(`${tool}: exited ${code}; output withheld to protect credentials`));
        });
      });
      assert.ok(output.includes(nonce), `${tool} did not return fixture contents`);
      const history = await client.gateway.history({ limit: 100 });
      assert.ok(
        history.records.some((request) => request.keyId === key.key.id && request.status === 'ok'),
        `${tool}: no completed Gateway request`,
      );
      console.log(`PASS ${tool} installed-client file-tool round trip (output withheld)`);
    }
    const httpHome = join(temporary, 'http');
    await mkdir(httpHome);
    await writeFile(join(httpHome, 'certification.txt'), nonce, 'utf8');
    const messages = [
      {
        role: 'user',
        content: 'Read certification.txt with read_file and reply with its exact contents.',
      },
    ];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', const: 'certification.txt' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
    ];
    async function httpTurn(conversation, toolChoice) {
      const response = await fetch(`${connection.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: conversation,
          tools,
          max_tokens: 256,
          tool_choice: toolChoice,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      assert.equal(response.status, 200);
      return (await response.json()).choices?.[0]?.message;
    }
    const assistant = await httpTurn(messages, {
      type: 'function',
      function: { name: 'read_file' },
    });
    const call = assistant?.tool_calls?.find((item) => item.function?.name === 'read_file');
    assert.ok(call?.id, 'Generic HTTP did not return a tool call');
    let argumentsValue;
    try {
      argumentsValue = JSON.parse(call.function.arguments);
    } catch {
      throw new Error('Generic HTTP returned invalid tool arguments; output withheld');
    }
    assert.ok(
      argumentsValue?.path === 'certification.txt',
      'Generic HTTP returned an unexpected path; output withheld',
    );
    const contents = await readFile(join(httpHome, 'certification.txt'), 'utf8');
    const final = await httpTurn(
      [...messages, assistant, { role: 'tool', tool_call_id: call.id, content: contents }],
      'none',
    );
    assert.ok(final?.content?.includes(nonce), 'Generic HTTP did not return fixture contents');
    console.log('PASS generic OpenAI HTTP file-tool round trip (output withheld)');
    await client.gateway.revokeKey(key.key.id);
  } finally {
    client?.close();
    await host?.stop();
    await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
