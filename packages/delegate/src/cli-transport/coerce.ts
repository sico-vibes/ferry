/** Local structural coercion helpers shared by the CLI transports (no `any` leaks). */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const items: unknown[] = [];
  value.forEach((item: unknown) => {
    items.push(item);
  });
  return items;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
