import { taskInferenceRouteSettlementSchema } from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "./bridge.js";
import { scheduleInferenceMetadataDelivery } from "./provider-inference-config.js";

class SettlementPending extends Error {}

/** Durable intent stays on the original round. These are coalesced delivery
 * wakeups, not grants, an execution queue, or another copy of a Task prompt. */
export function installTaskInferenceRouteDelivery(input: {
  repository: Pick<ServerRepository, "tasks" | "inferenceRevocations">;
  bridge: Pick<WorkerCommandBus, "request">;
  changed(ownerId: string, chatId: string): Promise<void>;
  report(error: unknown, workerId?: string): void;
}) {
  const { repository, bridge } = input;
  const report = (error: unknown, workerId?: string) => {
    if (!(error instanceof SettlementPending)) input.report(error, workerId);
  };
  const wake = (ownerId: string, workerId: string) =>
    scheduleInferenceMetadataDelivery(
      bridge,
      JSON.stringify(["task-route", ownerId, workerId]),
      async () => {
        let after: string | undefined;
        let settling = false;
        for (;;) {
          const pending =
            await repository.tasks.inferenceInputs.pendingRouteChanges(
              ownerId,
              workerId,
              after,
            );
          if (!pending.length) break;
          after = pending[pending.length - 1]!.source.dispatch.operationId;
          for (const change of pending) {
            const result = taskInferenceRouteSettlementSchema.parse(
              await bridge.request(
                workerId,
                {
                  type: "inference.task-revoke",
                  ownerId,
                  operationId: change.operationId,
                  source: change.source,
                },
                { ownerId, timeoutMs: 30_000 },
              ),
            );
            if (
              result.ownerId !== ownerId ||
              result.workerId !== workerId ||
              result.operationId !== change.operationId ||
              JSON.stringify(result.source) !== JSON.stringify(change.source)
            )
              throw new Error(
                "The Task input settlement belongs to another canonical operation.",
              );
            if (!result.settled) {
              settling = true;
              continue;
            }
            await repository.tasks.inferenceInputs.completeRouteChange(
              ownerId,
              workerId,
              change,
            );
            await input.changed(ownerId, change.source.chatId);
          }
        }
        if (settling) throw new SettlementPending();
      },
      report,
      workerId,
    );
  const recover = () =>
    scheduleInferenceMetadataDelivery(
      bridge,
      JSON.stringify(["task-route", null]),
      async () => {
        for (const scope of await repository.tasks.inferenceInputs.routeChangeScopes())
          wake(scope.ownerId, scope.workerId);
      },
      report,
    );
  const unsubscribe = repository.inferenceRevocations.subscribe((scope) => {
    if (scope) wake(scope.ownerId, scope.workerId);
    else recover();
  });
  recover();
  return { wake, close: unsubscribe };
}
