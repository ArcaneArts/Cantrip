import {
  cantripOsRecoveryResultSchema,
  type cantripOsRecoveryRequestSchema,
  type cantripOsObservedInstanceSchema,
  type CantripOsTransport,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import { CantripOsPlacementError } from "../db/repository/cantrip-os.js";
import {
  sameWorkerConnectionContinuityIdentity,
  type WorkerConnectionContinuityIdentity,
} from "../workers/bridge.js";
type Observed = ReturnType<typeof cantripOsObservedInstanceSchema.parse>;

export async function recoverCantripOsInstance(input: {
  ownerId: string;
  instanceId: string;
  expected: ReturnType<typeof cantripOsRecoveryRequestSchema.parse>;
  repository: Pick<ServerRepository, "cantripOs">;
  inspect: (input: {
    workerId: string;
    transport: CantripOsTransport;
  }) => Promise<Observed>;
  workerIdentity: (
    workerId: string,
  ) => WorkerConnectionContinuityIdentity | null;
}) {
  const { ownerId, instanceId, repository, expected } = input;
  const attachment = await repository.cantripOs.attachment(ownerId, instanceId);
  if (
    !attachment ||
    attachment.instance.attachmentGeneration !==
      expected.attachmentGeneration ||
    attachment.instance.runtimeGeneration !== expected.runtimeGeneration
  )
    throw new CantripOsPlacementError(
      "The selected OS attachment changed. Refresh the instance list before checking recovery.",
    );
  const { instance, transport } = attachment;
  const before = input.workerIdentity(instance.workerId);
  let actual: Observed | undefined;
  try {
    actual = await input.inspect({ workerId: instance.workerId, transport });
  } catch {
    // A failed observation cannot prove that the guest restarted. Retain the
    // last generation for comparison, while status revokes execution authority.
  }
  const after = input.workerIdentity(instance.workerId);
  const observedWorker =
    before?.ownerId === ownerId &&
    after &&
    sameWorkerConnectionContinuityIdentity(before, after)
      ? after.workerProcessGeneration
      : null;
  const previousWorker = attachment.workerProcessGeneration;
  const workerContinuity = !observedWorker
    ? "unavailable"
    : !previousWorker
      ? "first-observation"
      : previousWorker === observedWorker
        ? "same-worker"
        : "worker-restarted";
  const identityMatches =
    actual?.guestInstanceId === instance.guestInstanceId &&
    actual.attachment?.ownerId === ownerId &&
    actual.attachment.workerId === instance.workerId;
  const kind = !actual
    ? "unavailable"
    : !identityMatches
      ? "identity-changed"
      : !instance.runtimeGeneration
        ? "first-observation"
        : instance.runtimeGeneration === actual.runtimeGeneration
          ? "same-runtime"
          : "runtime-changed";
  const runtimeMessage = {
    unavailable:
      "The OS could not be verified through its Worker. Saved work remains recorded; check the connection and observe again before retrying work.",
    "identity-changed":
      "This connection reaches a different OS identity or attachment. The existing workspace was preserved; explicitly attach the intended instance.",
    "first-observation":
      "The OS is verified. Verify the intended project source before opening work.",
    "same-runtime":
      "The same OS runtime is verified. Existing captured targets still require their own current authorization; unfinished operations must be observed before retrying.",
    "runtime-changed":
      "The OS runtime changed. Verify retained project files, then create a new Linux agent or desktop view. Existing chats and old handles keep their original placement.",
  }[kind];
  const workerMessage = {
    "same-worker": "The same Worker process was verified.",
    "worker-restarted":
      "The Worker process restarted. Observe previously admitted guest work before deciding whether to launch new work.",
    "first-observation":
      "This is the first recorded Worker process observation for this attachment.",
    unavailable: "Worker process continuity could not be verified.",
  }[workerContinuity];
  const message = `${runtimeMessage} ${workerMessage}`;
  if (identityMatches)
    for (const workspace of actual!.workspaces)
      await repository.cantripOs.recordWorkspace(
        ownerId,
        instanceId,
        instance.attachmentGeneration,
        workspace,
      );
  const observed = await repository.cantripOs.observe(
    ownerId,
    instanceId,
    instance.attachmentGeneration,
    {
      status: identityMatches ? "connected" : "unknown",
      runtimeGeneration: identityMatches
        ? actual!.runtimeGeneration
        : instance.runtimeGeneration,
      lastError: identityMatches ? null : message,
      workerProcessGeneration: observedWorker ?? previousWorker,
    },
    instance.runtimeGeneration,
    previousWorker,
  );
  return cantripOsRecoveryResultSchema.parse({
    instance: observed,
    workspaces: await repository.cantripOs.listWorkspaces(ownerId, instanceId),
    recovery: {
      kind,
      message,
      previousRuntimeGeneration: instance.runtimeGeneration,
      observedRuntimeGeneration: identityMatches
        ? actual!.runtimeGeneration
        : null,
      workerContinuity,
      previousWorkerProcessGeneration: previousWorker,
      observedWorkerProcessGeneration: observedWorker,
    },
  });
}
