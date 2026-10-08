import { readFile } from 'node:fs/promises';
const rows = JSON.parse(await readFile(new URL('./input.json', import.meta.url), 'utf8'));
const totals = new Map();
for (const row of rows)
  if (row.active) totals.set(row.name, (totals.get(row.name) || 0) + row.amount);
console.log(
  JSON.stringify(
    [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([name, total]) => ({ name, total })),
    null,
    2,
  ),
);
