let windowActive = true;
const listeners = new Set<(active: boolean) => void>();

export function isCoreWindowActive(): boolean {
  return windowActive;
}

export function setCoreWindowActive(active: boolean): void {
  if (windowActive === active) return;
  windowActive = active;
  listeners.forEach((listener) => {
    listener(active);
  });
}

export function onCoreWindowActiveChange(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
