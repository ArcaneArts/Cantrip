import { cantripOsSystemFixtures } from "./cantrip-os-system-fixtures.mjs";
export function cantripOsSystemManagementFixtures() {
  const f = cantripOsSystemFixtures(),
    c = f.cantripOsSystemOperationCommandSchema[0];
  const { operationId, scope, target } = c;
  const common = {
    operationId,
    attachmentGeneration: scope.attachmentGeneration,
    targetGeneration: target.generation,
  };
  const request = { ...common, action: "capture", resumeOriginal: true };
  const control = {
    attachmentGeneration: scope.attachmentGeneration,
    targetGeneration: target.generation,
  };
  const publicTarget = {
    generation: target.generation,
    instanceId: scope.instanceId,
    workerId: scope.workerId,
    attachmentGeneration: scope.attachmentGeneration,
    architecture: target.architecture,
    running: true,
    verifiedAt: "2026-11-06T00:00:00.000Z",
  };
  const summary = {
    operationId,
    instanceId: scope.instanceId,
    workerId: scope.workerId,
    attachmentGeneration: scope.attachmentGeneration,
    targetGeneration: target.generation,
    request,
    context: {
      ...scope,
      operationId,
      targetGeneration: target.generation,
      containerId: target.containerId,
    },
    state: "ready",
    dispatchStage: "executing",
    phase: "complete",
    retiredBy: null,
    recoveryGeneration: null,
    root: null,
    protectedResult: f.cantripOsSystemProtectedOperationResultSchema[0],
    error: null,
    createdAt: publicTarget.verifiedAt,
    updatedAt: publicTarget.verifiedAt,
  };
  return {
    cantripOsSystemCreateSchema: [
      request,
      {
        ...common,
        action: "replace",
        source: { kind: "base", imageId: target.imageId },
      },
      {
        ...common,
        action: "replace",
        source: { kind: "checkpoint", operationId },
      },
      { ...common, action: "rollback", replacementOperationId: operationId },
    ],
    cantripOsSystemControlSchema: [control],
    cantripOsSystemTargetSummarySchema: [
      publicTarget,
      { ...publicTarget, architecture: null, running: null },
    ],
    cantripOsSystemStatusSchema: [
      {
        supported: true,
        target: publicTarget,
        bases: f.cantripOsSystemBaseImageSchema,
        error: null,
      },
      { supported: false, target: null, bases: [], error: "Unsupported" },
    ],
    cantripOsSystemSummarySchema: [
      summary,
      { ...summary, recoveryGeneration: operationId, retiredBy: operationId },
      {
        ...summary,
        state: "rejected",
        phase: "not-dispatched",
        protectedResult: null,
      },
    ],
    cantripOsSystemListQuerySchema: [{}, { limit: "10", cursor: operationId }],
    cantripOsSystemPageSchema: [{ items: [summary], nextCursor: null }],
  };
}
