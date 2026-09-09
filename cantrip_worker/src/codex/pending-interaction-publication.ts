/** Retry only idempotent pending-request metadata. Native input/replies never
 * enter this delivery loop, and publication cannot hold up Stop or a reply. */
export function publishPendingInteraction(options: {
  publish(): void | Promise<void>;
  isCurrent(): boolean;
  failed(error: unknown, attempt: number): void;
}): () => void {
  let cancelled = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = async () => {
    if (cancelled || !options.isCurrent()) return;
    try {
      await options.publish();
    } catch (error) {
      if (cancelled || !options.isCurrent()) return;
      failures += 1;
      try {
        options.failed(error, failures);
      } catch {
        // A diagnostic sink must not turn delivery failure into an unhandled
        // rejection or prevent the pending request's next delivery attempt.
      }
      if (cancelled || !options.isCurrent()) return;
      timer = setTimeout(
        () => {
          timer = null;
          void attempt();
        },
        Math.min(500 * 2 ** Math.min(failures - 1, 5), 10_000),
      );
      timer.unref();
    }
  };
  void attempt();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
