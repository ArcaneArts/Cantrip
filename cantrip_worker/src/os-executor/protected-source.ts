import {
  cantripOsProvisionRequestContentSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import { openWorkerRepositoryOperationContent } from "../repository-operation-encryption.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { WorkerRoutingRegistry } from "../routing-registry.js";

export async function prepareOsSourceCommand(
  command: Extract<WorkerCommand, { type: "cantrip-os.source.provision" }>,
  service: WorkerEncryptionService,
  routing: Pick<WorkerRoutingRegistry, "resolveToken">,
) {
  if (service.ownerId() !== command.scope.ownerId)
    throw new Error("OS source encryption belongs to a different owner.");
  const content = await openWorkerRepositoryOperationContent({
    context: {
      serverId: command.scope.serverId,
      projectId: command.scope.projectId,
      worktreeId: command.scope.worktreeId,
      operationId: command.operationId,
      direction: "request",
    },
    opaque: command.protectedRequest,
    schema: cantripOsProvisionRequestContentSchema,
    service,
    allowHistoricalKeyRevision: true,
  });
  if (
    content.instanceId !== command.scope.instanceId ||
    content.workspaceId !== command.scope.workspaceId ||
    content.bindingId !== command.scope.bindingId ||
    content.bindingGeneration !== command.scope.bindingGeneration
  )
    throw new Error(
      "Protected OS source intent does not match its admitted placement.",
    );
  const intent =
    content.intent.mode === "linked"
      ? {
          ...content.intent,
          workerPath: await routing.resolveToken(content.intent.workerPath),
        }
      : content.intent.source.kind === "git"
        ? {
            ...content.intent,
            source: {
              ...content.intent.source,
              repositoryUrl: await routing.resolveToken(
                content.intent.source.repositoryUrl,
              ),
            },
          }
        : content.intent;
  return {
    type: command.type,
    scope: command.scope,
    transport: command.transport,
    operationId: command.operationId,
    intent,
  };
}
