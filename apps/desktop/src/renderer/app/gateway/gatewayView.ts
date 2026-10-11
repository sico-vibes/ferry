import type { FerryClient } from '@ferry/client';
export type GatewayKeyRow = Awaited<ReturnType<FerryClient['gateway']['listKeys']>>[number];
export const presetOptions = [
  { value: 'auto-free', label: 'Auto — recommended' },
  { value: 'fast', label: 'Fast' },
  { value: 'best', label: 'Best quality' },
  { value: 'long-context', label: 'Long context' },
  { value: 'none', label: 'Choose a model' },
];
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return seconds < 60
    ? `${String(seconds)}s ago`
    : seconds < 3600
      ? `${String(Math.floor(seconds / 60))}m ago`
      : seconds < 86400
        ? `${String(Math.floor(seconds / 3600))}h ago`
        : `${String(Math.floor(seconds / 86400))}d ago`;
}
export const costText = (cost: number | null | undefined) =>
  cost == null ? 'Not recorded' : `$${cost.toFixed(4)}`;
export const durationText = (ms: number | null | undefined) =>
  ms == null
    ? 'Not measured'
    : ms >= 1000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${String(Math.round(ms))}ms`;
