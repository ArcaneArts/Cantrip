import { closeServerLogArchive, serverLogger } from "./logger.js";

export function installServerShutdownHandlers(app: {
  close(): Promise<void>;
}): void {
  let closing = false;
  const close = async (signal: NodeJS.Signals) => {
    if (closing) {
      return;
    }

    closing = true;
    const shutdownStartedAtMs = Date.now();
    serverLogger.event("info", "Cantrip Server shutdown began", {
      event: "server.shutdown.started",
      subsystem: "server-lifecycle",
      operation: "shutdown",
      reasonCode: signal.toLowerCase(),
      status: "stopping",
    });
    try {
      await app.close();
      serverLogger.event("info", "Cantrip Server shutdown completed", {
        event: "server.shutdown.completed",
        subsystem: "server-lifecycle",
        operation: "shutdown",
        status: "stopped",
        durationMs: Date.now() - shutdownStartedAtMs,
      });
    } catch (error) {
      // Local cleanup can finish while remote revocation remains unacknowledged.
      // Preserve that failure without leaving the signal callback's promise unowned.
      process.exitCode = 1;
      serverLogger.event("error", "Cantrip Server shutdown cleanup failed", {
        event: "server.shutdown.failed",
        subsystem: "server-lifecycle",
        operation: "shutdown",
        reasonCode: "cleanup-failed",
        status: "failed",
        durationMs: Date.now() - shutdownStartedAtMs,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      await closeServerLogArchive();
    }
  };

  const onSignal = (signal: NodeJS.Signals) => {
    void close(signal).catch((error: unknown) => {
      process.exitCode = 1;
      serverLogger.event(
        "error",
        "Cantrip Server shutdown finalization failed",
        {
          event: "server.shutdown.failed",
          subsystem: "server-lifecycle",
          operation: "shutdown",
          reasonCode: "shutdown-finalization-error",
          status: "failed",
          error: error instanceof Error ? error : new Error(String(error)),
        },
      );
    });
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
}
