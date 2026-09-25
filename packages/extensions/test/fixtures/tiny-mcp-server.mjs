import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'ferry-test-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo a string',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'wait',
      description: 'Wait for a while',
      inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
    },
    { name: 'crash', description: 'Crash the server', inputSchema: { type: 'object' } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'crash') process.exit(17);
  if (request.params.name === 'wait')
    await new Promise((resolve) => setTimeout(resolve, request.params.arguments?.ms ?? 60_000));
  return { content: [{ type: 'text', text: String(request.params.arguments?.text ?? 'done') }] };
});
await server.connect(new StdioServerTransport());
