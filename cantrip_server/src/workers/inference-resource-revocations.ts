import { workerCommandSchema } from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "./bridge.js";
import { serverLogger } from "../logger.js";
import { scheduleInferenceMetadataDelivery } from "./provider-inference-config.js";

type Repository = Pick<ServerRepository, "inferenceRevocations">;
type Commands = Pick<WorkerCommandBus, "request">;
const report = (error: unknown, workerId?: string) =>
  serverLogger.event(
    "warn",
    "Inference resource revocation delivery remains pending",
    {
      event: "inference.resource.delivery-pending",
      workerId,
      error: error instanceof Error ? error : new Error(String(error)),
    },
  );

export function synchronizeInferenceResourceRevocations(
  repository: Repository,
  bridge: Commands,
  ownerId: string,
  workerId: string,
): void {
  scheduleInferenceMetadataDelivery(
    bridge,
    JSON.stringify(["resource-revocations", ownerId, workerId]),
    async () => {
      for (;;) {
        const pending = await repository.inferenceRevocations.pending(
          ownerId,
          workerId,
        );
        if (!pending.length) return;
        for (const entry of pending) {
          const command = workerCommandSchema.parse({
            type: "inference.revoke",
            ownerId,
            target: entry.target,
          });
          // Attempt the actual authenticated control command, including offline
          // workers. Connectivity or model catalogs cannot gate resource cleanup.
          const result = await bridge.request(workerId, command, {
            ownerId,
            timeoutMs: 30_000,
          });
          if (
            !result ||
            typeof result !== "object" ||
            !("revoked" in result) ||
            result.revoked !== true ||
            !("ownerId" in result) ||
            result.ownerId !== ownerId ||
            !("workerId" in result) ||
            result.workerId !== workerId
          )
            throw new Error(
              "The resource revocation was not acknowledged by its worker scope.",
            );
          await repository.inferenceRevocations.acknowledge(
            ownerId,
            workerId,
            entry.id,
          );
        }
      }
    },
    report,
    workerId,
  );
}

/** Notifications are wakeups; pending rows remain the delivery authority. */
export function installInferenceResourceRevocationDelivery(
  repository: Repository,
  bridge: Commands,
): () => void {
  const recover = () =>
    scheduleInferenceMetadataDelivery(
      bridge,
      JSON.stringify(["resource-revocations", null]),
      async () => {
        for (const scope of await repository.inferenceRevocations.scopes())
          synchronizeInferenceResourceRevocations(
            repository,
            bridge,
            scope.ownerId,
            scope.workerId,
          );
      },
      report,
    );
  const unsubscribe = repository.inferenceRevocations.subscribe((scope) => {
    if (scope)
      synchronizeInferenceResourceRevocations(
        repository,
        bridge,
        scope.ownerId,
        scope.workerId,
      );
    else recover();
  });
  recover();
  return unsubscribe;
}
