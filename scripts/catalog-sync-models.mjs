import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const response = await fetch('https://models.dev/api.json');
if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
const snapshot = await response.json();
await writeFile(
  join(process.cwd(), 'data', 'models.snapshot.json'),
  `${JSON.stringify(snapshot)}\n`,
  'utf8',
);
console.log('Updated data/models.snapshot.json from models.dev/api.json');
