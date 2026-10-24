/** Tracks accepted asynchronous UI operations before transport drain. It does not
 * replay failed navigation or infer application completion from transport ACKs. */
export class BrowserOperationBoundary {
  private pending = new Set<Promise<unknown>>();
  private suspended = false;
  private disposed = false;
  private generation = 0;
  private failure: unknown;

  get accepting() {
    return !this.suspended && !this.disposed;
  }

  run<T>(operation: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(
        new Error("Browser input is suspended for transfer."),
      );
    const isCurrent = () => !this.disposed;
    const task = Promise.resolve().then(() => {
      if (!isCurrent()) throw new Error("Browser renderer was released.");
      return operation(isCurrent);
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      (error) => {
        if (this.suspended) this.failure = error;
        this.pending.delete(task);
      },
    );
    return task;
  }

  suspend(): () => void {
    if (!this.accepting)
      throw new Error("Browser renderer is unavailable for transfer.");
    this.suspended = true;
    const generation = ++this.generation;
    let released = false;
    return () => {
      if (released || this.disposed || generation !== this.generation) return;
      released = true;
      this.suspended = false;
      // The failure has been surfaced; cancellation does not replay an operation.
      this.failure = undefined;
    };
  }

  async drain(): Promise<void> {
    if (!this.suspended || this.disposed)
      throw new Error("Suspend browser input before capture.");
    const generation = this.generation;
    await Promise.allSettled([...this.pending]);
    if (!this.suspended || this.disposed || generation !== this.generation)
      throw new Error("Browser transfer was cancelled during capture.");
    if (this.failure !== undefined) throw this.failure;
  }

  dispose() {
    this.disposed = true;
    this.generation++;
  }
}
