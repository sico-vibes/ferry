import type { UsageRecord } from '@ferry/shared';

export type WindowSpec =
  | { kind: 'rolling'; length: number }
  | { kind: 'fixed_daily'; tz: string; time: string }
  | { kind: 'weekly_fixed'; dow: number; tz: string; time?: string }
  | { kind: 'weekly_from_first_use'; tz: string }
  | { kind: 'monthly_from_anchor'; day: number; tz?: string }
  | { kind: 'dynamic_5h' };

export interface UsageAmounts {
  requests: number;
  tokens: number;
  usd: number;
  credits: number;
}

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const parts = (date: Date, tz: string) => {
  const entries = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  return Object.fromEntries(entries.map(({ type, value }) => [type, value]));
};
const localStamp = (year: number, month: number, date: number, hourValue: number, minute: number) =>
  Date.UTC(year, month - 1, date, hourValue, minute);

function localToUtc(
  year: number,
  month: number,
  date: number,
  hourValue: number,
  minute: number,
  tz: string,
): Date {
  const target = localStamp(year, month, date, hourValue, minute);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const p = parts(new Date(guess), tz);
    const represented = localStamp(
      Number(p.year),
      Number(p.month),
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
    );
    const delta = target - represented;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess);
}
function parseTime(value: string | undefined): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? '00:00');
  if (!match) throw new RangeError(`Invalid window time: ${String(value)}`);
  return [Number(match[1]), Number(match[2])];
}
function midnightShift(date: Date, tz: string, amount: number): Date {
  const p = parts(date, tz);
  const local = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + amount));
  return localToUtc(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), 0, 0, tz);
}

export function windowStart(
  now: Date,
  spec: WindowSpec,
  records: readonly UsageRecord[] = [],
): Date {
  if (spec.kind === 'rolling') return new Date(now.getTime() - spec.length * 1000);
  if (spec.kind === 'dynamic_5h') return new Date(now.getTime() - 5 * hour);
  if (spec.kind === 'weekly_from_first_use') {
    const first = records.reduce<number | undefined>((earliest, record) => {
      const ts = Date.parse(record.occurredAt);
      return ts <= now.getTime() && (earliest === undefined || ts < earliest) ? ts : earliest;
    }, undefined);
    return first === undefined
      ? new Date(now)
      : new Date(first + Math.floor((now.getTime() - first) / (7 * day)) * 7 * day);
  }
  const tz = spec.kind === 'monthly_from_anchor' ? (spec.tz ?? 'UTC') : spec.tz;
  const p = parts(now, tz);
  if (spec.kind === 'fixed_daily') {
    const [h, m] = parseTime(spec.time);
    let start = localToUtc(Number(p.year), Number(p.month), Number(p.day), h, m, tz);
    if (start.getTime() > now.getTime()) {
      const previous = parts(midnightShift(start, tz, -1), tz);
      start = localToUtc(
        Number(previous.year),
        Number(previous.month),
        Number(previous.day),
        h,
        m,
        tz,
      );
    }
    return start;
  }
  if (spec.kind === 'weekly_fixed') {
    const [h, m] = parseTime(spec.time);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? 'Sun');
    const date = new Date(
      Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) - ((weekday - spec.dow + 7) % 7)),
    );
    let start = localToUtc(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      h,
      m,
      tz,
    );
    if (start > now) {
      const previous = parts(midnightShift(start, tz, -7), tz);
      start = localToUtc(
        Number(previous.year),
        Number(previous.month),
        Number(previous.day),
        h,
        m,
        tz,
      );
    }
    return start;
  }
  const anchor = Math.min(
    spec.day,
    new Date(Date.UTC(Number(p.year), Number(p.month), 0)).getUTCDate(),
  );
  let start = localToUtc(Number(p.year), Number(p.month), anchor, 0, 0, tz);
  if (start > now) {
    const previousMonth = new Date(Date.UTC(Number(p.year), Number(p.month) - 2, 1));
    const previousDay = Math.min(
      spec.day,
      new Date(
        Date.UTC(previousMonth.getUTCFullYear(), previousMonth.getUTCMonth() + 1, 0),
      ).getUTCDate(),
    );
    start = localToUtc(
      previousMonth.getUTCFullYear(),
      previousMonth.getUTCMonth() + 1,
      previousDay,
      0,
      0,
      tz,
    );
  }
  return start;
}

export function nextReset(now: Date, spec: WindowSpec, records: readonly UsageRecord[] = []): Date {
  if (spec.kind === 'rolling')
    return new Date(windowStart(now, spec, records).getTime() + spec.length * 1000);
  if (spec.kind === 'dynamic_5h') {
    const next = records
      .map((record) => Date.parse(record.occurredAt) + 5 * hour)
      .filter((ts) => ts > now.getTime())
      .sort((a, b) => a - b)[0];
    return new Date(next ?? now.getTime() + 5 * hour);
  }
  if (spec.kind === 'weekly_from_first_use')
    return new Date(windowStart(now, spec, records).getTime() + 7 * day);
  if (spec.kind === 'fixed_daily') {
    const [h, m] = parseTime(spec.time);
    const start = windowStart(now, spec, records);
    const p = parts(midnightShift(start, spec.tz, 1), spec.tz);
    return localToUtc(Number(p.year), Number(p.month), Number(p.day), h, m, spec.tz);
  }
  if (spec.kind === 'weekly_fixed') {
    const start = windowStart(now, spec, records);
    const [h, m] = parseTime(spec.time);
    const p = parts(midnightShift(start, spec.tz, 7), spec.tz);
    return localToUtc(Number(p.year), Number(p.month), Number(p.day), h, m, spec.tz);
  }
  const start = windowStart(now, spec, records);
  const tz = spec.tz ?? 'UTC';
  const p = parts(start, tz);
  const month = new Date(Date.UTC(Number(p.year), Number(p.month), 1));
  const anchor = Math.min(
    spec.day,
    new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate(),
  );
  return localToUtc(month.getUTCFullYear(), month.getUTCMonth() + 1, anchor, 0, 0, tz);
}

export function usageIn(
  window: { start: Date; end: Date },
  records: readonly UsageRecord[],
): UsageAmounts {
  const usage: UsageAmounts = { requests: 0, tokens: 0, usd: 0, credits: 0 };
  for (const record of records) {
    const at = Date.parse(record.occurredAt);
    if (at < window.start.getTime() || at >= window.end.getTime()) continue;
    usage.requests += 1;
    usage.tokens += (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
    usage.usd += record.costUsd ?? 0;
    usage.credits += record.planUnits ?? record.costUsd ?? 0;
  }
  return usage;
}

export function remaining(
  limit: number | null,
  usage: number,
  authoritative?: number | null,
): number | null {
  if (authoritative !== undefined && authoritative !== null) return Math.max(0, authoritative);
  return limit === null ? null : Math.max(0, limit - usage);
}
