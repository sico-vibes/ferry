const knownSecrets = new Map<string, number>();

export function redactKnownSecretText(text: string): string {
  let redacted = text;
  for (const value of [...knownSecrets.keys()].sort((a, b) => b.length - a.length)) {
    if (value) redacted = redacted.split(value).join('[REDACTED]');
  }
  return redacted;
}

export function redactKnownSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactKnownSecretText(value);
  if (Array.isArray(value)) return value.map(redactKnownSecrets);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactKnownSecretText(key),
        redactKnownSecrets(item),
      ]),
    );
  return value;
}

export function rememberSecret(value: string): void {
  knownSecrets.set(value, (knownSecrets.get(value) ?? 0) + 1);
}

export function forgetSecret(value: string): void {
  const count = knownSecrets.get(value) ?? 0;
  if (count <= 1) knownSecrets.delete(value);
  else knownSecrets.set(value, count - 1);
}

export function isKnownSecret(value: string): boolean {
  return knownSecrets.has(value);
}
