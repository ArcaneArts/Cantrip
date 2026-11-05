import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "./bridge.js";
import { workerInferenceStatusSchema } from "@cantrip/protocol";

/** Configuration delivery never grants a ticket or restarts a native process. */
export async function synchronizeProviderInference(
  repository: Pick<ServerRepository, "readProviderInferenceCatalog">,
  bridge: Pick<WorkerCommandBus, "request">,
  ownerId: string,
  workerId: string,
): Promise<void> {
  const catalog = await repository.readProviderInferenceCatalog(ownerId);
  const result = workerInferenceStatusSchema.parse(
    await bridge.request(
      workerId,
      { type: "inference.configure", ...catalog },
      { ownerId, timeoutMs: 30_000 },
    ),
  );
  if (
    result.workerId !== workerId ||
    result.ownerId !== ownerId ||
    result.providerCatalogRevision === undefined ||
    result.providerCatalogRevision < catalog.catalogRevision
  )
    throw new Error(
      "Provider inference configuration was acknowledged by a different worker scope.",
    );
}

/** A committed catalog mutation is not rolled back by an offline worker. */
export async function synchronizeAllProviderInference(
  repository: Pick<
    ServerRepository,
    "readProviderInferenceCatalog" | "listWorkers"
  >,
  bridge: Pick<WorkerCommandBus, "request">,
  ownerId: string,
  report: (error: unknown, workerId?: string) => void,
): Promise<void> {
  const observe = (error: unknown, workerId?: string) => {
    try {
      report(error, workerId);
    } catch {
      /* Diagnostics cannot undo a committed catalog mutation. */
    }
  };
  try {
    const workers = await repository.listWorkers(ownerId);
    const deliveries = await Promise.allSettled(
      workers.map(({ workerId }) =>
        synchronizeProviderInference(repository, bridge, ownerId, workerId),
      ),
    );
    deliveries.forEach((result, index) => {
      if (result.status === "rejected")
        observe(result.reason, workers[index]!.workerId);
    });
  } catch (error) {
    observe(error);
  }
}
