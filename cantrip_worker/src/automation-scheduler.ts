import {
  projectAutomationDispatchResultSchema,
  projectAutomationListSchema,
} from "@cantrip/protocol/automations";

export interface ProjectAutomationSchedulerOptions {
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  serverUrl: string;
  token: string;
  workerId: string;
}

export class ProjectAutomationScheduler {
  readonly #fetch: typeof fetch;
  readonly #inFlight = new Set<string>();
  readonly #pollIntervalMs: number;
  readonly #serverUrl: string;
  readonly #token: string;
  readonly #workerId: string;
  #closed = false;
  #lastError: string | null = null;
  #running = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ProjectAutomationSchedulerOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.#serverUrl = options.serverUrl.replace(/\/$/u, "");
    this.#token = options.token;
    this.#workerId = options.workerId;
  }

  start(): void {
    if (this.#timer || this.#closed) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#pollIntervalMs);
    this.#timer.unref();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#closed || this.#running) return;
    this.#running = true;
    try {
      const url = new URL("/api/internal/workers/automations", this.#serverUrl);
      url.searchParams.set("workerId", this.#workerId);
      const response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`schedule refresh failed with HTTP ${response.status}`);
      }
      const automations = projectAutomationListSchema.parse(
        await response.json(),
      );
      this.#lastError = null;
      const results = await Promise.allSettled(
        automations.map(async (automation) => {
          if (
            !automation.nextRunAt ||
            new Date(automation.nextRunAt).getTime() > now.getTime() ||
            this.#inFlight.has(automation.id)
          ) {
            return;
          }
          this.#inFlight.add(automation.id);
          try {
            const dispatchUrl = new URL(
              `/api/internal/workers/automations/${encodeURIComponent(automation.id)}/dispatch`,
              this.#serverUrl,
            );
            dispatchUrl.searchParams.set("workerId", this.#workerId);
            const dispatched = await this.#fetch(dispatchUrl, {
              body: JSON.stringify({
                revision: automation.revision,
                scheduledFor: automation.nextRunAt,
              }),
              headers: {
                authorization: `Bearer ${this.#token}`,
                "content-type": "application/json",
              },
              method: "POST",
              signal: AbortSignal.timeout(15_000),
            });
            if (!dispatched.ok) {
              throw new Error(
                `automation dispatch failed with HTTP ${dispatched.status}`,
              );
            }
            projectAutomationDispatchResultSchema.parse(
              await dispatched.json(),
            );
          } finally {
            this.#inFlight.delete(automation.id);
          }
        }),
      );
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed) throw failed.reason;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.#closed && message !== this.#lastError) {
        console.warn(
          `[cantrip_worker] Automation sync unavailable: ${message}`,
        );
      }
      this.#lastError = message;
    } finally {
      this.#running = false;
    }
  }
}
