import {
  CODE_WORKBENCH_READY_TIMEOUT_MS,
  codeWorkbenchFrameFailure,
  codeWorkbenchStageError,
  isCodeWorkbenchReadyEvent,
  type CodeWorkbenchFrameMount,
  type CodeWorkbenchStageError,
} from "./code-workbench-frame";

export type CodeWorkbenchStartupStage =
  "bootstrapping" | "restoring" | "restored";

export function codeWorkbenchRetryDelayMs(
  attempt: number,
  baseMs: number,
  maximumMs: number,
): number {
  return Math.min(maximumMs, baseMs * 2 ** Math.max(0, attempt));
}

interface CodeWorkbenchReadinessOptions {
  mount: CodeWorkbenchFrameMount;
  frameWindow(): Window | null;
  ready?: boolean;
  failed?: boolean;
  timeoutEnabled: boolean;
  onReady(): void;
  onFailure(error: CodeWorkbenchStageError): void;
  onTimeout(error: CodeWorkbenchStageError): void;
  onStage?(stage: CodeWorkbenchStartupStage): void;
}

/** A timeout is advisory; only an exact document failure ends this mount. */
export function watchCodeWorkbenchReadiness(
  options: CodeWorkbenchReadinessOptions,
): () => void {
  let cancelled = false;
  let settled = options.ready === true || options.failed === true;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
  };
  const receive = (event: MessageEvent<unknown>) => {
    if (cancelled || settled) return;
    const frame = options.frameWindow();
    const failure = codeWorkbenchFrameFailure(event, frame, options.mount);
    if (failure) {
      settled = true;
      clearTimers();
      options.onFailure(failure);
      return;
    }
    if (isCodeWorkbenchReadyEvent(event, frame, options.mount)) {
      settled = true;
      clearTimers();
      options.onReady();
      return;
    }
    if (
      !frame ||
      event.source !== frame ||
      event.origin !== options.mount.origin ||
      !event.data ||
      typeof event.data !== "object"
    )
      return;
    const message = event.data as Record<string, unknown>;
    if (
      message.type === "cantrip-code.workbench-stage" &&
      message.version === 1 &&
      message.nonce === options.mount.nonce &&
      (message.stage === "bootstrapping" ||
        message.stage === "restoring" ||
        message.stage === "restored")
    ) {
      options.onStage?.(message.stage);
    }
  };
  window.addEventListener("message", receive);
  if (!settled) {
    // Bounded queries repair a missed one-shot signal. Older editors simply
    // ignore this additive message and still send the original ready event.
    for (const delayMs of [0, 250, 1_000, 5_000]) {
      timers.push(
        setTimeout(() => {
          if (cancelled || settled) return;
          const frame = options.frameWindow();
          if (typeof frame?.postMessage !== "function") return;
          try {
            frame.postMessage(
              {
                type: "cantrip-code.workbench-query",
                version: 1,
                nonce: options.mount.nonce,
              },
              options.mount.origin,
            );
          } catch {
            // A replaced frame cannot answer. Its owner's cleanup ends this watch.
          }
        }, delayMs),
      );
    }
    if (options.timeoutEnabled) {
      timers.push(
        setTimeout(() => {
          if (cancelled || settled) return;
          options.onTimeout(
            codeWorkbenchStageError(
              "workbench",
              "The embedded editor timed out after its endpoint loaded.",
            ),
          );
        }, CODE_WORKBENCH_READY_TIMEOUT_MS),
      );
    }
  }
  return () => {
    cancelled = true;
    clearTimers();
    window.removeEventListener("message", receive);
  };
}
