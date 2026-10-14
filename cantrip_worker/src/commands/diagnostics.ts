import { readWorkerLogs } from "../logger.js";
import type { WorkerCommand } from "@cantrip/protocol";
import type { WorkerLogStreamManager } from "../log-stream.js";

export type DiagnosticsCommand = Extract<
  WorkerCommand,
  {
    type:
      | "diagnostics.logs.read"
      | "diagnostics.logs.stream.start"
      | "diagnostics.logs.stream.renew"
      | "diagnostics.logs.stream.stop";
  }
>;
export interface DiagnosticsCommandDependencies {
  workerLogStreams: Pick<WorkerLogStreamManager, "start" | "renew" | "stop">;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleDiagnosticsCommand(
  command: DiagnosticsCommand,
  dependencies: DiagnosticsCommandDependencies,
): Promise<unknown> {
  const { workerLogStreams } = dependencies;
  switch (command.type) {
    case "diagnostics.logs.read":
      return readWorkerLogs(command);
    case "diagnostics.logs.stream.start":
      return workerLogStreams.start(command);
    case "diagnostics.logs.stream.renew":
      return workerLogStreams.renew(command.subscriptionId, command.leaseMs);
    case "diagnostics.logs.stream.stop":
      return workerLogStreams.stop(command.subscriptionId);
  }
}
