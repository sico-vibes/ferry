const REDACTIONS: readonly [RegExp, string][] = [
  // Bearer tokens and Authorization headers.
  [/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]'],
  [/(authorization"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1[redacted]'],
  // Common API key prefixes.
  [/\b(sk-[A-Za-z0-9_-]{6,})/g, '[redacted]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  // Keyed secret fields, e.g. "api_key": "..." / access_token=...
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|token)"?\s*[:=]\s*"?)[^\s",}]+/gi,
    '$1[redacted]',
  ],
  // JWT-ish long base64url blobs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
];

/** Strip secrets, control characters and excess length from a message intended for humans. */
export function redactText(input: string): string {
  let text = input;
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  // Remove ANSI/control characters (except common whitespace) so logs and errors stay readable.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const trimmed = text.trim();
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}
