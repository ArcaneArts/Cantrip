import type { CantripOsDesktopWorkerCommand } from "@cantrip/protocol";
import type { CantripOsController } from "./controller.js";
import {
  OsExecutorConnection,
  OsExecutorDeliveryError,
  type OsExecutorBinding,
} from "./connection.js";
import { runGuestProcess } from "./process.js";

export interface DesktopDriver {
  run(
    command: CantripOsDesktopWorkerCommand,
    args: string[],
    hooks?: {
      opened(binding: OsExecutorBinding, sessionId: string): Promise<void>;
      prepared(processId: string, argv: string[]): Promise<void>;
    },
  ): Promise<unknown>;
}

/** Uses the captured native executor, never an unpinned host shell. sudo belongs
 * to the selected account and carries no model credentials into the guest. */
export class CapturedDesktopDriver implements DesktopDriver {
  constructor(
    private readonly controller: Pick<
      CantripOsController,
      "captureAdministrativeBinding"
    >,
  ) {}
  async run(
    command: CantripOsDesktopWorkerCommand,
    args: string[],
    hooks?: Parameters<DesktopDriver["run"]>[2],
  ) {
    const binding = await this.controller.captureAdministrativeBinding(
      command.transport,
      command.scope,
    );
    const connection = new OsExecutorConnection(command.transport, binding);
    try {
      const initialized = await connection.request<{ sessionId: string }>(
        "initialize",
        { clientName: "cantrip-desktop-administration", resumeSessionId: null },
      );
      connection.notify("initialized");
      await hooks?.opened(binding, initialized.sessionId);
      const argv = ["sudo", "-n", "--", "/usr/bin/cantrip-workspaces", ...args];
      const result = await runGuestProcess(
        connection,
        argv,
        command.scope.homeGuestPath,
        {
          maxDurationMs: 90_000,
          maxOutputBytes: 512 * 1024,
          prepared: async (processId) => hooks?.prepared(processId, argv),
        },
      );
      if (
        result.exitCode !== 0 ||
        result.outputTruncated ||
        result.failure ||
        result.terminationRequested
      ) {
        const error = new OsExecutorDeliveryError(
          "The desktop command did not return a complete verified outcome.",
        );
        error.cause = result;
        throw error;
      }
      try {
        return JSON.parse(result.stdout);
      } catch (cause) {
        const error = new OsExecutorDeliveryError(
          "The desktop command returned an unreadable outcome.",
        );
        error.cause = cause;
        throw error;
      }
    } finally {
      await connection.close();
    }
  }
}
