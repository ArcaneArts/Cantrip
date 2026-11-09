import { nativeTurnRecoveryObservationSchema } from "@cantrip/protocol";
import type { ChatExecutionContext } from "../../db/repository.js";
import { prepareManagedTurnConfiguration } from "../../terminals/managed-session.js";
import type { TaskRouteRuntimeDependencies } from "./task-route-types.js";

/** Resume/read the saved native thread without submitting another input. */
export function createTaskNativeTurnObserver(
  dependencies: Pick<
    TaskRouteRuntimeDependencies,
    | "applicationOwnerId"
    | "bridge"
    | "repository"
    | "runtimeForContext"
    | "routePairsForConfiguration"
  >,
) {
  return async (context: ChatExecutionContext, turnId: string) => {
    if (!context.threadId)
      throw new Error("Task recovery requires its original native thread.");
    const ownerId = dependencies.applicationOwnerId();
    const runtime = await dependencies.runtimeForContext(context);
    if (!runtime) throw new Error("Selected model was not found.");
    const { configuration } = await prepareManagedTurnConfiguration(
      context,
      runtime,
      { ...dependencies, ownerId },
    );
    const result = (await dependencies.bridge.request(
      context.workerId,
      {
        type: "chat.thread.ensure",
        cwd: context.cwd,
        threadId: context.threadId,
        ...configuration,
        recoveryTurnId: turnId,
      },
      { ownerId, timeoutMs: null },
    )) as { threadId: string; recovery?: unknown };
    if (result.threadId !== context.threadId)
      throw new Error("The recovered Task thread changed.");
    const observed = nativeTurnRecoveryObservationSchema.parse(result.recovery);
    if (observed.threadId !== context.threadId || observed.turnId !== turnId)
      throw new Error(
        "The observed native turn belongs to another Task input.",
      );
    return observed;
  };
}
