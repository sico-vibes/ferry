import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const { url } = await serveDirectory(join(scriptDirectory, '..', 'out', 'web'), 5174);
process.stdout.write(`Serving built Ferry renderer at ${url}\n`);
