import {
  projectAutomationDispatchResultSchema,
  projectAutomationWireListSchema,
} from "@cantrip/protocol/automations";

import { workerLogError, workerLogger } from "./logger.js";

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
  #lastScheduleFingerprint: string | null = null;
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
    workerLogger.event("info", "Automation schedule synchronization started", {
      event: "automation.schedule-sync.started",
      subsystem: "automation",
      operation: "sync-schedules",
      status: "started",
      workerId: this.#workerId,
      pollIntervalMs: this.#pollIntervalMs,
    });
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#pollIntervalMs);
    this.#timer.unref();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    workerLogger.event("info", "Automation schedule synchronization stopped", {
      event: "automation.schedule-sync.stopped",
      subsystem: "automation",
      operation: "sync-schedules",
      status: "completed",
      workerId: this.#workerId,
      counts: { inFlight: this.#inFlight.size },
    });
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#closed || this.#running) return;
    this.#running = true;
    const syncStartedAtMs = Date.now();
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
      const automations = projectAutomationWireListSchema.parse(
        await response.json(),
      );
      const recovered = this.#lastError !== null;
      this.#lastError = null;
      const fingerprint = automations
        .map(
          ({ enabled, id, nextRunAt, revision }) =>
            `${id}:${revision}:${enabled ? "enabled" : "paused"}:${nextRunAt ?? "none"}`,
        )
        .sort()
        .join("|");
      if (recovered || fingerprint !== this.#lastScheduleFingerprint) {
        workerLogger.event(
          recovered ? "info" : "debug",
          recovered
            ? "Automation schedule synchronization recovered"
            : "Automation schedules synchronized",
          {
            event: recovered
              ? "automation.schedule-sync.recovered"
              : "automation.schedule-sync.completed",
            subsystem: "automation",
            operation: "sync-schedules",
            status: "completed",
            durationMs: Date.now() - syncStartedAtMs,
            workerId: this.#workerId,
            counts: {
              schedules: automations.length,
              enabled: automations.filter(({ enabled }) => enabled).length,
              paused: automations.filter(({ enabled }) => !enabled).length,
            },
          },
        );
      }
      this.#lastScheduleFingerprint = fingerprint;
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
          const dispatchStartedAtMs = Date.now();
          workerLogger.event("info", "Due automation dispatch began", {
            event: "automation.dispatch.started",
            subsystem: "automation",
            operation: "dispatch",
            status: "started",
            workerId: this.#workerId,
            projectId: automation.projectId,
            chatId: automation.chatId,
            automationId: automation.id,
            revision: automation.revision,
          });
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
            const result = projectAutomationDispatchResultSchema.parse(
              await dispatched.json(),
            );
            workerLogger.event("info", "Due automation dispatched", {
              event: "automation.dispatch.completed",
              subsystem: "automation",
              operation: "dispatch",
              status: "completed",
              resultStatus: result.status,
              durationMs: Date.now() - dispatchStartedAtMs,
              workerId: this.#workerId,
              projectId: automation.projectId,
              chatId: automation.chatId,
              automationId: automation.id,
              revision: automation.revision,
            });
          } catch (error) {
            workerLogger.event("warn", "Due automation dispatch failed", {
              event: "automation.dispatch.failed",
              subsystem: "automation",
              operation: "dispatch",
              reasonCode: "dispatch-failed",
              status: "failed",
              durationMs: Date.now() - dispatchStartedAtMs,
              workerId: this.#workerId,
              projectId: automation.projectId,
              chatId: automation.chatId,
              automationId: automation.id,
              revision: automation.revision,
              error: workerLogError(error),
            });
            throw error;
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
        workerLogger.rateLimited(
          `automation-sync-unavailable:${this.#workerId}`,
          "warn",
          "Automation schedule synchronization unavailable",
          {
            event: "automation.schedule-sync.failed",
            subsystem: "automation",
            operation: "sync-schedules",
            reasonCode: "request-failed",
            status: "retrying",
            durationMs: Date.now() - syncStartedAtMs,
            workerId: this.#workerId,
            error: workerLogError(error),
          },
        );
      }
      this.#lastError = message;
    } finally {
      this.#running = false;
    }
  }
}
