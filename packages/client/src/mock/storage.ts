export interface StorageAdapter {
  load(): unknown;
  save(data: unknown): void;
}
export function memoryStorage(): StorageAdapter {
  let data: unknown;
  return {
    load: () => data,
    save: (value) => {
      data = value;
    },
  };
}
export function localStorageAdapter(key = 'ferry.mock.v1'): StorageAdapter {
  const fallback = memoryStorage();
  return {
    load() {
      try {
        const raw = globalThis.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as unknown) : fallback.load();
      } catch {
        return fallback.load();
      }
    },
    save(data) {
      fallback.save(data);
      try {
        globalThis.localStorage.setItem(key, JSON.stringify(data));
      } catch {
        /* memory fallback */
      }
    },
  };
}
