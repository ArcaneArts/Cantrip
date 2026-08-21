interface CachedRequest<T> {
  expiresAt: number;
  promise: Promise<T>;
}

export class ShortLivedRequestCache<T> {
  readonly #entries = new Map<string, CachedRequest<T>>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.#entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const entry: CachedRequest<T> = {
      expiresAt: Number.POSITIVE_INFINITY,
      promise: Promise.resolve().then(load),
    };
    this.#entries.set(key, entry);
    void entry.promise.then(
      () => {
        if (this.#entries.get(key) === entry) {
          entry.expiresAt = Date.now() + this.ttlMs;
        }
      },
      () => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      },
    );
    return entry.promise;
  }

  set(key: string, value: T): void {
    this.#entries.set(key, {
      expiresAt: Date.now() + this.ttlMs,
      promise: Promise.resolve(value),
    });
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}
