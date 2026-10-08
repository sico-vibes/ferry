import { z } from 'zod';

export const PageSnapshotSchema = z.object({
  title: z.string(),
  text: z.string().transform((value) => value.slice(0, 600)),
  scrollWidth: z.number(),
  clientWidth: z.number(),
  offenders: z.array(z.object({ selector: z.string(), right: z.number() })).max(5),
});

export function parsePageSnapshot(value: unknown) {
  const snapshot = PageSnapshotSchema.parse(value);
  return { ...snapshot, overflow: snapshot.scrollWidth > snapshot.clientWidth };
}

const RemoteArgumentSchema = z.object({
  value: z.unknown().optional(),
  description: z.string().optional(),
});
export function parseConsoleEvent(value: unknown): { level: string; text: string } | null {
  const parsed = z
    .object({ type: z.string(), args: z.array(RemoteArgumentSchema) })
    .safeParse(value);
  if (!parsed.success || !['error', 'warning', 'warn'].includes(parsed.data.type)) return null;
  return {
    level: parsed.data.type,
    text: parsed.data.args
      .map((arg) =>
        typeof arg.value === 'string'
          ? arg.value
          : arg.value !== undefined
            ? JSON.stringify(arg.value)
            : (arg.description ?? ''),
      )
      .join(' '),
  };
}

export function parseExceptionEvent(value: unknown): string | null {
  const parsed = z
    .object({
      exceptionDetails: z.object({ text: z.string(), exception: RemoteArgumentSchema.optional() }),
    })
    .safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.exceptionDetails.exception?.description ?? parsed.data.exceptionDetails.text;
}

export function parseLogEvent(value: unknown): { level: string; text: string } | null {
  const parsed = z
    .object({ entry: z.object({ level: z.string(), text: z.string() }) })
    .safeParse(value);
  if (!parsed.success || !['error', 'warning'].includes(parsed.data.entry.level)) return null;
  return parsed.data.entry;
}

export function parseFailedRequest(url: string, value: unknown) {
  const parsed = z
    .object({
      errorText: z.string(),
      type: z.string().optional(),
      blockedReason: z.string().optional(),
    })
    .parse(value);
  // These failures stay visible, but don't masquerade as application failures offline.
  const ignored =
    /ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_(?:REFUSED|TIMED_OUT)|NETWORK_CHANGED)/.test(
      parsed.errorText,
    ) &&
    (parsed.type === 'Font' ||
      /(?:fonts\.(?:googleapis|gstatic)\.com|(?:^|[./-])cdn[./-]|cdnjs|jsdelivr|unpkg)/i.test(url));
  return { url, ...parsed, ignored };
}

export const PAGE_SNAPSHOT_EXPRESSION = `(() => {
  const root = document.documentElement;
  const selector = el => el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
  return {
    title: document.title,
    text: (document.body?.innerText || '').slice(0, 600),
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    offenders: [...document.querySelectorAll('body *')].map(el => ({ el, rect: el.getBoundingClientRect() })).filter(({rect}) => rect.width > 0 && rect.height > 0 && rect.right > root.clientWidth + 1).slice(0, 5).map(({el, rect}) => ({selector: selector(el), right: rect.right}))
  };
})()`;
