import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "./bridge.js";
import { workerInferenceStatusSchema } from "@cantrip/protocol";

/** Configuration delivery never grants a ticket or restarts a native process. */
export async function synchronizeProviderInference(
  repository: Pick<ServerRepository, "listProviderInferenceConfigurations">,
  bridge: Pick<WorkerCommandBus, "request">,
  ownerId: string,
  workerId: string,
): Promise<void> {
  const configurations =
    await repository.listProviderInferenceConfigurations(ownerId);
  const result = workerInferenceStatusSchema.parse(
    await bridge.request(
      workerId,
      { type: "inference.configure", configurations },
      { ownerId, timeoutMs: 30_000 },
    ),
  );
  if (result.workerId !== workerId || result.ownerId !== ownerId)
    throw new Error(
      "Provider inference configuration was acknowledged by a different worker scope.",
    );
}
