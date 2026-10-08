import { createApp } from './app.mjs';
const data = new Map();
const app = createApp({ getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v) });
try {
  console.log(JSON.stringify(app.execute(process.argv.slice(2).join(' '))));
} catch {
  process.exitCode = 2;
}
