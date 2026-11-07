import {
  cantripOsSystemSummarySchema,
  cantripOsSystemOperationCommandSchema,
  cantripOsInstanceSummarySchema,
} from "@cantrip/protocol";

/** Test data only, shared by system API, encryption and component acceptance tests. */
export const systemTestId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function cantripOsSystemTestFixture() {
  const scope = {
    ownerId: "owner",
    serverId: "server",
    workerId: "worker",
    instanceId: systemTestId(1),
    guestInstanceId: systemTestId(5),
    attachmentGeneration: systemTestId(2),
  };
  const at = "2026-11-06T00:00:00.000Z";
  const context = {
    ...scope,
    operationId: systemTestId(4),
    targetGeneration: systemTestId(3),
    containerId: "a".repeat(64),
  };
  const destination = {
    instanceId: scope.instanceId,
    workerId: scope.workerId,
    attachmentGeneration: scope.attachmentGeneration,
    targetGeneration: context.targetGeneration,
  };
  const target = {
    generation: context.targetGeneration,
    instanceId: scope.instanceId,
    workerId: scope.workerId,
    attachmentGeneration: scope.attachmentGeneration,
    architecture: "amd64",
    running: true,
    verifiedAt: at,
  };
  const physical = {
    generation: context.targetGeneration,
    containerId: context.containerId,
    containerName: "cantrip-system-test",
    imageId: `sha256:${"b".repeat(64)}`,
    architecture: "amd64",
    identityEvidence: "guest-identity",
    expected: {
      guestInstanceId: scope.guestInstanceId,
      ownerId: scope.ownerId,
      workerId: scope.workerId,
      identityPath: "/private/guest/identity.json",
    },
  };
  const request = {
    operationId: context.operationId,
    attachmentGeneration: scope.attachmentGeneration,
    targetGeneration: context.targetGeneration,
    action: "capture" as const,
    resumeOriginal: true,
  };
  const command = cantripOsSystemOperationCommandSchema.parse({
    type: "cantrip-os.system.capture",
    mode: "execute",
    operationId: context.operationId,
    action: "capture",
    resumeOriginal: true,
    checkpointId: systemTestId(8),
    scope,
    transport: { kind: "docker", container: physical.containerName },
    target: physical,
  });
  const summary = cantripOsSystemSummarySchema.parse({
    operationId: context.operationId,
    instanceId: scope.instanceId,
    workerId: scope.workerId,
    attachmentGeneration: systemTestId(9),
    targetGeneration: context.targetGeneration,
    context,
    request,
    state: "unknown",
    dispatchStage: "executing",
    phase: "capture-unobserved",
    retiredBy: null,
    recoveryGeneration: null,
    root: null,
    protectedResult: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  });
  const instance = cantripOsInstanceSummarySchema.parse({
    id: scope.instanceId,
    ownerId: scope.ownerId,
    workerId: scope.workerId,
    guestInstanceId: scope.guestInstanceId,
    attachmentGeneration: scope.attachmentGeneration,
    name: "Test CantripOS",
    status: "connected",
    runtimeGeneration: systemTestId(6),
    lastError: null,
    lastObservedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  return {
    scope,
    context,
    destination,
    target,
    physical,
    request,
    command,
    summary,
    instance,
    at,
  };
}
