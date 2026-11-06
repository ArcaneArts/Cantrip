// Controlled native boundary; all ownership/epoch/receipt writes use real SQL services.
import { WorkerCommandError } from "../../cantrip_server/src/workers/bridge.ts";
import { nativeCommandAdmissionSchema } from "../../packages/protocol/dist/index.js";
export async function durableResumePeer(repository, input, worker, command) {
  if (input.coldResumeError)
    throw new WorkerCommandError(
      "Controlled saved-source failure",
      input.coldResumeError,
    );
  const state = await repository.nativeSuspensions.read(
    input.owner,
    command.chatId,
  );
  if (input.coldResumeNoAck) return { paused: false, active: state.active };
  const session = {
    chatId: command.chatId,
    threadId: command.threadId,
    contextKind: command.session.contextKind,
    projectId: command.session.projectId,
    placementId: command.session.worktreeId ?? command.session.scratchRootId,
    modelRouteId: command.model.routeId,
    providerAccountId: command.provider.accountId ?? null,
    runtimeGeneration: "replacement-runtime",
    connectionId: "replacement-connection",
  };
  const workerGeneration = "809cc8d8-4f56-4f61-ae0c-d21b621891c2";
  const request = {
    workerId: worker,
    workerGeneration,
    operationId: input.pausePrefix + "-observer",
    controlId: command.controlId,
    checkpoint: command.checkpoint,
    session,
    payloadDigest: "a".repeat(64),
    protectedPayload: input.pauseProtectedPayload,
  };
  const grant = await repository.nativeCommands.admitSuspendedExecution(
    input.owner,
    request,
  );
  const apply = async (receipt) => {
    await repository.nativeCommands.dispatch(input.owner, {
      workerId: worker,
      workerGeneration,
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      payloadDigest: receipt.payloadDigest,
      session,
    });
    await repository.nativeCommands.settle(input.owner, {
      workerId: worker,
      workerGeneration,
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      status: "applied",
      resultDigest: "b".repeat(64),
      protectedResult: input.pauseProtectedPayload,
      rejectionCode: null,
      executionComplete: false,
      ...(receipt.method === "turn/pause"
        ? { durableSuspension: true }
        : {
            reconciliation: {
              nativeTurnId: state.active.turnId,
              runtimeGeneration: session.runtimeGeneration,
            },
          }),
    });
  };
  await apply(grant.receipt);
  const resumed = await repository.nativeCommands.admit(
    input.owner,
    nativeCommandAdmissionSchema.parse({
      workerId: worker,
      operationId: input.pausePrefix + "-resume",
      origin: "gui",
      method: "turn/pause",
      session,
      payloadDigest: "c".repeat(64),
      protectedPayload: input.pauseProtectedPayload,
      expectedActivationGeneration: grant.receipt.activationGeneration,
      intent: {
        scope: "thread",
        durableSuspension: true,
        workerGeneration,
        expectedTurnId: state.active.turnId,
        expectedSuspensionControlId: command.controlId,
        paused: false,
        resumeAutonomy: true,
      },
    }),
  );
  if (resumed.receipt.status !== "accepted")
    throw new Error(resumed.receipt.rejectionCode);
  await apply(resumed.receipt);
  return { paused: false, active: state.active };
}
