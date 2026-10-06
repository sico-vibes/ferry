import { redactKnownSecretText } from './security/secrets.js';

export interface TraceContext {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  sessionId?: string;
  messageId?: string;
  stepId?: string;
  turnId?: string;
  requestGroupId?: string;
  deviceId?: string;
  appVersion?: string;
}

export function newTraceId(): string {
  return randomHex(16);
}

export function newSpanId(): string {
  return randomHex(8);
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const credentialKey =
  /^(?:authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|session[_-]?token|bearer|private[_-]?key)$/i;
const secretShapes =
  /\b(?:sk-or-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sb_secret_[A-Za-z0-9_-]+|sb_publishable_[A-Za-z0-9_-]+|xox[abp]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;
const pemPrivateKey =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g;
const maxStringLength = 32_768;

export interface RedactionOptions {
  /** Longest string kept before truncation; logs cap at 32 KiB, synced records pass Infinity. */
  maxStringLength?: number;
}

export function redactForTelemetry(value: unknown, options: RedactionOptions = {}): unknown {
  const limit = options.maxStringLength ?? maxStringLength;
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      const capped = item.length > limit ? `${item.slice(0, limit)}[TRUNCATED]` : item;
      return redactKnownSecretText(capped)
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
        .replace(secretShapes, '[REDACTED]')
        .replace(pemPrivateKey, '[REDACTED]');
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          credentialKey.test(key) &&
          (typeof child === 'string' || (child !== null && typeof child === 'object'))
            ? '[REDACTED]'
            : visit(child),
        ]),
      );
    }
    return item;
  };
  return visit(value);
}

export interface TelemetrySink {
  log(event: Record<string, unknown>): void;
  turnStarted(turn: Record<string, unknown>): void;
  turnUpdated(turnId: string, patch: Record<string, unknown>): void;
  modelSwitch(record: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export const NoopTelemetrySink: TelemetrySink = {
  log: () => undefined,
  turnStarted: () => undefined,
  turnUpdated: () => undefined,
  modelSwitch: () => undefined,
  flush: () => Promise.resolve(),
};
