import {
  nativeTurnSuspensionSchema,
  type NativeCommandSession,
  type NativeTurnSuspension,
} from "@cantrip/protocol";
import type { NativeSuspensionStore } from "../native-suspension-store.js";
import type { CodexAppServer } from "./app-server.js";

/** Shared by GUI and terminal settlement. It captures only the admitted native
 * turn and does not release inference, queues, or the native execution hold. */
export function createManagedSuspensionCapture(
  runtime: Pick<
    CodexAppServer,
    | "captureTurnSuspension"
    | "inspectTurnSuspension"
    | "managedHistoryHome"
    | "compatibility"
    | "captureWorkerTurnContinuation"
  >,
  store: NativeSuspensionStore,
) {
  return async ({
    session,
    turnId,
    suspension: inputSuspension,
  }: {
    session: NativeCommandSession;
    turnId: string;
    suspension?: NativeTurnSuspension;
  }) => {
    if (!session.threadId)
      throw new Error("The paused native thread identity is missing.");
    const suspension = inputSuspension
      ? nativeTurnSuspensionSchema.parse(inputSuspension)
      : await runtime.captureTurnSuspension(session.threadId, turnId);
    if (
      suspension.threadId !== session.threadId ||
      suspension.turnId !== turnId
    )
      throw new Error("The durable pause belongs to a different native turn.");
    const evidence = await store.commit({
      source: {
        chatId: session.chatId,
        threadId: session.threadId,
        contextKind: session.contextKind,
        projectId: session.projectId,
        placementId: session.placementId,
        modelRouteId: session.modelRouteId,
        providerAccountId: session.providerAccountId,
      },
      home: runtime.managedHistoryHome,
      suspension,
      // Diagnostic only. Native checkpoint decoding decides compatibility.
      runtimeVersion: runtime.compatibility.version?.raw ?? "unknown",
      runtimeFingerprint: null,
      continuation: runtime.captureWorkerTurnContinuation(
        suspension.threadId,
        suspension.turnId,
      ),
    });
    const observed = await runtime.inspectTurnSuspension(suspension.threadId);
    if (
      !observed.paused ||
      JSON.stringify(observed.suspension) !== JSON.stringify(suspension)
    )
      throw new Error(
        "The native turn changed while its suspension source was committed.",
      );
    return evidence;
  };
}

/** Only this exact stronger form of the admitted Pause may bypass the public
 * method catalogue. It cannot select another thread, turn or operation. */
export function isDurablePauseRewrite(
  frame: Record<string, unknown>,
  forward: { method: string; params: Record<string, unknown> },
): boolean {
  const params = frame.params as Record<string, unknown> | undefined;
  const operation = forward.params.operation as
    Record<string, unknown> | undefined;
  return (
    frame.method === "turn/pause" &&
    !!params &&
    params.paused === true &&
    typeof params.threadId === "string" &&
    typeof params.turnId === "string" &&
    forward.method === "turn/suspension" &&
    forward.params.threadId === params.threadId &&
    Object.keys(forward.params).sort().join(",") === "operation,threadId" &&
    !!operation &&
    operation.type === "pause" &&
    operation.turnId === params.turnId &&
    Object.keys(operation).sort().join(",") === "turnId,type"
  );
}
