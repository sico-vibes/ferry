import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}
export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  chunks?: unknown[];
  delayMs?: number;
  malformedToolCall?: boolean;
}
export interface FakeServerOptions {
  responses?: FakeResponse[];
  models?: { id: string; supported_parameters?: string[] }[];
  responseHeaders?: Record<string, string>;
  slowMs?: number;
}

export class FakeProviderServer {
  protected server: Server | undefined;
  readonly requests: RecordedRequest[] = [];
  private cursor = 0;
  baseUrl = '';
  readonly options: FakeServerOptions;
  constructor(options: FakeServerOptions = {}) {
    this.options = options;
  }
  protected matches(_url: string): boolean {
    return true;
  }
  async start(): Promise<this> {
    if (this.server) return this;
    this.server = createServer((req, res) => void this.handle(req, res));
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake server did not bind TCP');
    this.baseUrl = `http://127.0.0.1:${String(address.port)}`;
    return this;
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  protected async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parts: string[] = [];
    for await (const part of req) parts.push(Buffer.from(part).toString('utf8'));
    let body: unknown;
    const rawBody = parts.join('');
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    const url = req.url ?? '/';
    this.requests.push({ method: req.method ?? 'GET', url, headers: req.headers, body });
    if (!this.matches(url)) {
      res.writeHead(404).end();
      return;
    }
    const modelList = this.modelListResponse(req.method ?? 'GET', url);
    if (modelList !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(modelList));
      return;
    }
    const scripted =
      this.options.responses?.[this.cursor++ % Math.max(1, this.options.responses.length)] ?? {};
    const streaming = url.includes('stream') || (body as { stream?: boolean } | undefined)?.stream;
    const headers = {
      'content-type': streaming ? 'text/event-stream' : 'application/json',
      ...this.options.responseHeaders,
      ...scripted.headers,
    };
    res.writeHead(scripted.status ?? 200, headers);
    if (scripted.status && scripted.status >= 400) {
      res.end(
        JSON.stringify(
          scripted.body ?? { error: { message: 'scripted failure', type: 'rate_limit_error' } },
        ),
      );
      return;
    }
    const payload = scripted.body ?? this.responseFor(body, scripted.malformedToolCall ?? false);
    if (streaming) {
      const chunks = scripted.chunks ?? [payload];
      for (const chunk of chunks) {
        if (this.options.slowMs || scripted.delayMs)
          await delay(scripted.delayMs ?? this.options.slowMs);
        if (!res.destroyed) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (!res.destroyed) res.end('data: [DONE]\n\n');
    } else res.end(JSON.stringify(payload));
  }
  protected responseFor(_body: unknown, _malformed: boolean): unknown {
    return { ok: true };
  }
  protected modelListResponse(_method: string, _url: string): unknown {
    return undefined;
  }
}

export class FakeOpenAIServer extends FakeProviderServer {
  protected override matches(url: string): boolean {
    return url.endsWith('/chat/completions') || url.endsWith('/models');
  }
  protected override modelListResponse(method: string, url: string): unknown {
    if (method !== 'GET' || !url.endsWith('/models')) return undefined;
    if (this.options.models) return { data: this.options.models };
    if (url.startsWith('/openrouter/'))
      return {
        data: [{ id: 'cohere/north-mini-code:free', supported_parameters: ['tools'] }],
      };
    if (url.startsWith('/groq/')) return { data: [{ id: 'allam-2-7b' }] };
    return { data: [{ id: 'gpt-4o-mini' }] };
  }
  protected override responseFor(_body: unknown, malformed: boolean): unknown {
    const call = {
      id: 'call_fake_1',
      type: 'function',
      function: { name: 'read_file', arguments: malformed ? '{broken' : '{"path":"README.md"}' },
    };
    return {
      id: 'chatcmpl_fake',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Fake response',
            tool_calls: [call],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    };
  }
  static scriptedTurns(turns: FakeResponse[]): FakeOpenAIServer {
    return new FakeOpenAIServer({ responses: turns });
  }
}
export class FakeAnthropicServer extends FakeProviderServer {
  protected override matches(url: string): boolean {
    return url.startsWith('/v1/messages');
  }
  protected override responseFor(): unknown {
    return {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_fake', name: 'read_file', input: { path: 'README.md' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 8 },
    };
  }
}
export class FakeGeminiServer extends FakeProviderServer {
  protected override matches(url: string): boolean {
    return /:generateContent|:streamGenerateContent/.test(url);
  }
  static rateLimited(
    retrySeconds = 30,
    quotaMetric = 'generate_content_free_tier_requests',
  ): FakeGeminiServer {
    return new FakeGeminiServer({
      responses: [
        {
          status: 429,
          body: {
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              message: 'Quota exceeded',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                  retryDelay: `${String(retrySeconds)}s`,
                },
                {
                  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                  violations: [{ quotaMetric }],
                },
              ],
            },
          },
        },
      ],
    });
  }
  protected override responseFor(): unknown {
    return {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Fake Gemini response' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
    };
  }
}
export class FakeOpenRouterKeyEndpoint extends FakeProviderServer {
  private readonly keyInfo: {
    limit_remaining: number;
    free_model_daily_requests: { remaining: number; limit: number };
  };
  constructor(
    keyInfo = {
      limit_remaining: 5,
      free_model_daily_requests: { remaining: 42, limit: 50 },
    },
  ) {
    super();
    this.keyInfo = keyInfo;
  }
  protected override matches(url: string): boolean {
    return url === '/api/v1/key';
  }
  protected override handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== '/api/v1/key') {
      res.writeHead(404).end();
      return Promise.resolve();
    }
    this.requests.push({
      method: req.method ?? 'GET',
      url: req.url,
      headers: req.headers,
      body: undefined,
    });
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ data: this.keyInfo }));
    return Promise.resolve();
  }
}
