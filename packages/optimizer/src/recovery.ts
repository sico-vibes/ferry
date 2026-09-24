export interface BlobStore {
  put(sessionId: string, content: string): string;
  get(handle: string): string | undefined;
  deleteSession(sessionId: string): void;
}
interface StoredBlob {
  sessionId: string;
  content: string;
  expiresAt: number;
}
let sequence = 0;
export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, StoredBlob>();
  constructor(
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}
  put(sessionId: string, content: string): string {
    this.prune();
    const handle = `ferry-output-${String(++sequence)}`;
    this.blobs.set(handle, { sessionId, content, expiresAt: this.now() + this.ttlMs });
    return handle;
  }
  get(handle: string): string | undefined {
    this.prune();
    return this.blobs.get(handle)?.content;
  }
  deleteSession(sessionId: string): void {
    for (const [handle, blob] of this.blobs)
      if (blob.sessionId === sessionId) this.blobs.delete(handle);
  }
  private prune(): void {
    const now = this.now();
    for (const [handle, blob] of this.blobs) if (blob.expiresAt <= now) this.blobs.delete(handle);
  }
}
export const defaultBlobStore = new InMemoryBlobStore();
export interface ReadOutputOptions {
  startLine?: number;
  endLine?: number;
  grep?: string | RegExp;
}
export function readOutput(handle: string, options?: ReadOutputOptions): string | undefined;
export function readOutput(
  store: BlobStore,
  handle: string,
  options?: ReadOutputOptions,
): string | undefined;
export function readOutput(
  first: BlobStore | string,
  second: string | ReadOutputOptions = {},
  third: ReadOutputOptions = {},
): string | undefined {
  const store = typeof first === 'string' ? defaultBlobStore : first;
  const handle = typeof first === 'string' ? first : (second as string);
  const options = typeof first === 'string' ? (second as ReadOutputOptions) : third;
  const content = store.get(handle);
  if (content === undefined) return undefined;
  const lines =
    content
      .match(/.*(?:\r\n|\n|\r|$)/g)
      ?.filter((line, i, all) => line.length > 0 || i < all.length - 1) ?? [];
  const start = Math.max(1, options.startLine ?? 1);
  const end = Math.max(start, options.endLine ?? lines.length);
  return lines
    .slice(start - 1, end)
    .filter(
      (line) =>
        options.grep === undefined ||
        (typeof options.grep === 'string' ? line.includes(options.grep) : options.grep.test(line)),
    )
    .join('');
}
