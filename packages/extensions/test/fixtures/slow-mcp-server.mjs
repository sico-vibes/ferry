import { appendFile, access } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const marker = process.env.FERRY_MCP_STARTS_FILE;
const first = !(await access(marker).then(
  () => true,
  () => false,
));
await appendFile(marker, `${process.pid}\n`);
if (first) await new Promise((resolve) => setTimeout(resolve, 2_000));
await import('./tiny-mcp-server.mjs');
