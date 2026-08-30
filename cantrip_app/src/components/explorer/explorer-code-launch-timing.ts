import type { ServiceLogLevel } from "@cantrip/logging/records";

import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";

export type ExplorerCodeLaunchKind = "file" | "prewarm";

export type ExplorerCodeLaunchPhase =
  | "session-route"
  | "transport-ready"
  | "frame-document"
  | "workbench-ready"
  | "presentation-ready"
  | "file-open";

export interface ExplorerCodeLaunchContext {
  actionKind?: string;
  attachmentReadyAtRequest: boolean;
  editorInstanceId: string;
  explorerId: string;
  interactionId?: string;
  intentAgeMs?: number;
  launchKind: ExplorerCodeLaunchKind;
  requestedAtMs?: number;
  workerId: string;
  workerOnlineAtRequest: boolean;
  workbenchReadyAtRequest: boolean;
  worktreeId: string;
}

type ExplorerCodeLaunchLog = (
  level: ServiceLogLevel,
  message: string,
  context: Record<string, unknown> & {
    event: string;
    subsystem: string;
  },
) => void;

interface ExplorerCodeLaunchTimingDependencies {
  createId(): string;
  log: ExplorerCodeLaunchLog;
  now(): number;
}

export interface ExplorerCodeLaunchPhaseTiming {
  cancel(reasonCode: string): void;
  complete(details?: Record<string, unknown>): void;
  fail(error: unknown, details?: Record<string, unknown>): void;
}

const defaultDependencies: ExplorerCodeLaunchTimingDependencies = {
  createId: () => crypto.randomUUID(),
  log: (level, message, context) => clientLogger.event(level, message, context),
  now: () => performance.now(),
};

function roundedDuration(startedAtMs: number, completedAtMs: number): number {
  return Math.max(0, Math.round(completedAtMs - startedAtMs));
}

export class ExplorerCodeLaunchTiming {
  readonly launchId: string;

  #attempts = new Map<ExplorerCodeLaunchPhase, number>();
  #checkpointAtMs: number;
  #finished = false;
  #startedAtMs: number;

  constructor(
    private readonly context: ExplorerCodeLaunchContext,
    private readonly dependencies: ExplorerCodeLaunchTimingDependencies = defaultDependencies,
  ) {
    this.launchId = dependencies.createId();
    this.#startedAtMs = dependencies.now();
    this.#checkpointAtMs = this.#startedAtMs;
    this.#emit("info", "Cantrip Code editor launch started", {
      event: "code.editor.launch.started",
      operation: "launch-editor",
      status: "started",
    });
  }

  beginPhase(phase: ExplorerCodeLaunchPhase): ExplorerCodeLaunchPhaseTiming {
    const startedAtMs = this.dependencies.now();
    const attempt = (this.#attempts.get(phase) ?? 0) + 1;
    this.#attempts.set(phase, attempt);
    let settled = false;
    const settle = (
      status: "cancelled" | "completed" | "failed",
      details: Record<string, unknown> = {},
      error?: unknown,
    ) => {
      if (settled || this.#finished) return;
      settled = true;
      const completedAtMs = this.dependencies.now();
      if (status === "completed") this.#checkpointAtMs = completedAtMs;
      this.#emit(
        status === "failed"
          ? "warn"
          : status === "cancelled"
            ? "debug"
            : "info",
        `Cantrip Code editor launch phase ${status}`,
        {
          ...details,
          ...(error === undefined ? {} : operationalErrorMetadata(error)),
          attempt,
          durationMs: roundedDuration(startedAtMs, completedAtMs),
          event: "code.editor.launch.phase",
          operation: "launch-editor",
          phase,
          status,
          totalDurationMs: roundedDuration(this.#startedAtMs, completedAtMs),
        },
      );
    };
    return {
      cancel: (reasonCode) => settle("cancelled", { reasonCode }),
      complete: (details) => settle("completed", details),
      fail: (error, details) => settle("failed", details, error),
    };
  }

  milestone(
    phase: ExplorerCodeLaunchPhase,
    details: Record<string, unknown> = {},
  ): void {
    if (this.#finished) return;
    const completedAtMs = this.dependencies.now();
    const attempt = (this.#attempts.get(phase) ?? 0) + 1;
    this.#attempts.set(phase, attempt);
    this.#emit("info", "Cantrip Code editor launch phase completed", {
      ...details,
      attempt,
      durationMs: roundedDuration(this.#checkpointAtMs, completedAtMs),
      event: "code.editor.launch.phase",
      operation: "launch-editor",
      phase,
      status: "completed",
      totalDurationMs: roundedDuration(this.#startedAtMs, completedAtMs),
    });
    this.#checkpointAtMs = completedAtMs;
  }

  complete(details: Record<string, unknown> = {}): void {
    if (this.#finished) return;
    this.#finished = true;
    const completedAtMs = this.dependencies.now();
    this.#emit("info", "Cantrip Code editor launch completed", {
      ...details,
      durationMs: roundedDuration(this.#startedAtMs, completedAtMs),
      event: "code.editor.launch.completed",
      operation: "launch-editor",
      status: "completed",
    });
  }

  fail(
    phase: ExplorerCodeLaunchPhase,
    error: unknown,
    details: Record<string, unknown> = {},
  ): void {
    if (this.#finished) return;
    this.#finished = true;
    const completedAtMs = this.dependencies.now();
    this.#emit("error", "Cantrip Code editor launch failed", {
      ...details,
      ...operationalErrorMetadata(error),
      durationMs: roundedDuration(this.#startedAtMs, completedAtMs),
      event: "code.editor.launch.failed",
      operation: "launch-editor",
      phase,
      status: "failed",
    });
  }

  cancel(reasonCode: string): void {
    if (this.#finished) return;
    this.#finished = true;
    const completedAtMs = this.dependencies.now();
    this.#emit("debug", "Cantrip Code editor launch cancelled", {
      durationMs: roundedDuration(this.#startedAtMs, completedAtMs),
      event: "code.editor.launch.cancelled",
      operation: "launch-editor",
      reasonCode,
      status: "cancelled",
    });
  }

  #emit(
    level: ServiceLogLevel,
    message: string,
    details: Record<string, unknown> & {
      event: string;
      operation: string;
      status: string;
    },
  ): void {
    this.dependencies.log(level, message, {
      ...this.context,
      ...details,
      launchId: this.launchId,
      subsystem: "code",
    });
  }
}
