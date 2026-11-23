import type { CantripOsRunWorkerCommand } from "@cantrip/protocol";
import {
  protectedRunConfigurationRuntimeWorkerOutputSchema,
  runConfigurationRuntimeOutputContentSchema,
} from "@cantrip/protocol/run-configuration-runtime";
import type { RunConfigurationRuntimeSupervisor } from "../run-configuration-runtime-supervisor.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import { protectWorkerRunContent } from "../run-content-encryption.js";

export async function handleOsRunCommand(
  command: CantripOsRunWorkerCommand,
  runtimes: RunConfigurationRuntimeSupervisor,
  encryption: WorkerEncryptionService,
): Promise<unknown> {
  switch (command.type) {
    case "cantrip-os.run-runtime.start":
      return runtimes.start(command);
    case "cantrip-os.run-runtime.restart":
      return runtimes.restart(command);
    case "cantrip-os.run-runtime.stop":
      return runtimes.stop(command);
    case "cantrip-os.run-runtime.status":
      return runtimes.status(command.identity, command);
    case "cantrip-os.run-runtime.reconcile":
      return runtimes.reconcileLinux(command.captures);
    case "cantrip-os.run-runtime.output": {
      const snapshot = runtimes.output(command);
      return protectedRunConfigurationRuntimeWorkerOutputSchema.parse({
        requestOperationId: command.requestOperationId,
        identity: snapshot.identity,
        protectedOutput: await protectWorkerRunContent({
          serverId: command.serverId,
          projectId: command.identity.projectId,
          worktreeId: command.identity.worktreeId,
          operationId: command.requestOperationId,
          operation: "run.configuration.output",
          content: { data: snapshot.data, truncated: snapshot.truncated },
          schema: runConfigurationRuntimeOutputContentSchema,
          service: encryption,
        }),
      });
    }
  }
}
