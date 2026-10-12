import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

export interface ZenTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}
export interface ZenToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Advertise real caller tools. Capture a call; execution remains with the caller. */
export async function openZenToolBridge(tools: readonly ZenTool[]) {
  const token = randomUUID();
  const aliases = new Map(tools.map((tool, i) => [`tool_${String(i)}`, tool]));
  let resolveCall!: (call: ZenToolCall) => void;
  const called = new Promise<ZenToolCall>((resolve) => {
    resolveCall = resolve;
  });
  const schema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  });
  const server = createServer((req, res) => {
    void (async () => {
      if (
        req.headers.authorization !== `Bearer ${token}` ||
        req.url !== '/mcp' ||
        req.headers.origin
      ) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      try {
        let body = '';
        let size = 0;
        for await (const rawChunk of req) {
          const chunk: unknown = rawChunk;
          size += Buffer.byteLength(String(chunk));
          if (size > 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
          body += String(chunk);
        }
        const message = schema.parse(JSON.parse(body));
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const reply = (result: unknown) => {
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        };
        if (message.method === 'initialize')
          reply({
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'Ferry caller tools', version: '1.0.0' },
          });
        else if (message.method === 'tools/list')
          reply({
            tools: [...aliases].map(([name, tool]) => ({
              name,
              description: `${tool.name}: ${tool.description ?? 'Caller-owned tool'}`,
              inputSchema: tool.parameters,
            })),
          });
        else if (message.method === 'tools/call') {
          const name = message.params?.name;
          const tool = typeof name === 'string' ? aliases.get(name) : undefined;
          const args = z.record(z.string(), z.unknown()).safeParse(message.params?.arguments ?? {});
          if (!tool || !args.success) throw new Error('Unknown caller tool or invalid arguments');
          resolveCall({ id: `call_${randomUUID()}`, name: tool.name, arguments: args.data });
          // Leave the call pending until the ACP subprocess is stopped. Never feed
          // an invented tool result to the model or execute on the gateway host.
        } else reply({});
      } catch {
        if (!res.headersSent) res.writeHead(400).end();
      }
    })().catch(() => {
      res.destroy();
    });
  });
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    called,
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`,
    token,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
