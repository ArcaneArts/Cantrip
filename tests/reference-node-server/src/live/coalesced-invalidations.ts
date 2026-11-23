export interface CoalescedInvalidationOptions<Value> {
  delayMs: number;
  limit: number;
  publish(value: Value): void;
}

export class CoalescedInvalidations<Value> {
  readonly #delayMs: number;
  readonly #entries = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; value: Value }
  >();
  readonly #limit: number;
  readonly #publish: (value: Value) => void;

  constructor(options: CoalescedInvalidationOptions<Value>) {
    this.#delayMs = options.delayMs;
    this.#limit = options.limit;
    this.#publish = options.publish;
  }

  schedule(key: string, value: Value, immediate = false): void {
    const existing = this.#entries.get(key);
    if (existing) {
      if (!immediate) {
        existing.value = value;
        return;
      }
      clearTimeout(existing.timer);
      this.#entries.delete(key);
      this.#publish(value);
      return;
    }
    if (immediate) {
      this.#publish(value);
      return;
    }
    if (this.#entries.size >= this.#limit) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.#entries.get(oldestKey);
        if (oldest) {
          clearTimeout(oldest.timer);
          this.#publish(oldest.value);
        }
        this.#entries.delete(oldestKey);
      }
    }
    const entry = {
      timer: setTimeout(() => {
        const current = this.#entries.get(key);
        this.#entries.delete(key);
        if (current) this.#publish(current.value);
      }, this.#delayMs),
      value,
    };
    entry.timer.unref();
    this.#entries.set(key, entry);
  }

  close(): void {
    for (const entry of this.#entries.values()) clearTimeout(entry.timer);
    this.#entries.clear();
  }
}
