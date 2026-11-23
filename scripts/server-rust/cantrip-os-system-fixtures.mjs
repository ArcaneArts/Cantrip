export function cantripOsSystemFixtures() {
  const id = "11111111-1111-4111-8111-111111111111",
    cid = "a".repeat(64),
    at = "2026-11-06T00:00:00.000Z";
  const scope = {
    ownerId: "owner",
    workerId: "worker",
    serverId: "server",
    instanceId: id,
    guestInstanceId: id,
    attachmentGeneration: id,
  };
  const target = {
    generation: id,
    expected: {
      guestInstanceId: id,
      ownerId: "owner",
      workerId: "worker",
      identityPath: "/var/lib/cantrip-os-executor/instance.json",
    },
    containerId: cid,
    containerName: "cantrip-os",
    imageId: `sha256:${"b".repeat(64)}`,
    architecture: "amd64",
    identityEvidence: "guest-identity",
  };
  const reference = { operationId: id, scope, targetGeneration: id };
  const context = {
    ...scope,
    operationId: id,
    targetGeneration: id,
    containerId: cid,
  };
  const captureAdmission = {
    context: { ...context, checkpointId: id },
    container: "cantrip-os",
    resumeOriginal: true,
  };
  const transport = { kind: "docker", container: "cantrip-os" };
  const common = { mode: "execute", operationId: id, scope, transport, target };
  const capture = {
    ...common,
    type: "cantrip-os.system.capture",
    action: "capture",
    checkpointId: id,
    resumeOriginal: true,
  };
  const replace = {
    ...common,
    type: "cantrip-os.system.replace",
    action: "replace",
    source: { kind: "checkpoint", capture: captureAdmission },
    startTarget: true,
  };
  const rollback = {
    ...common,
    type: "cantrip-os.system.rollback",
    action: "rollback",
    replacement: reference,
    startTarget: false,
  };
  const status = {
    type: "cantrip-os.system.status",
    scope,
    transport,
    target,
    recovery: reference,
  };
  const base = {
    imageId: target.imageId,
    architecture: "amd64",
    tags: ["cantrip-os:local"],
  };
  const envelope = {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(22),
  };
  const root = {
    requestSha256: "c".repeat(64),
    originalContainerId: cid,
    targetContainerId: "d".repeat(64),
    retainedContainerId: cid,
    runtimeHandlesRestored: false,
    guestInstanceId: id,
    guestAttachment: "owned",
  };
  const result = {
    operationId: id,
    targetGeneration: id,
    action: "replace",
    state: "ready",
    phase: "complete",
    startedAt: at,
    updatedAt: at,
    protectedResult: envelope,
    root,
    error: null,
  };
  return {
    cantripOsSystemScopeSchema: [scope],
    cantripOsSystemTargetSchema: [
      target,
      { ...target, architecture: null, identityEvidence: "retained-container" },
    ],
    cantripOsSystemReferenceSchema: [reference],
    cantripOsSystemBaseImageSchema: [base],
    cantripOsSystemSourceSchema: [
      replace.source,
      { kind: "base", imageId: base.imageId },
    ],
    cantripOsSystemOperationCommandSchema: [capture, replace, rollback],
    cantripOsSystemWorkerCommandSchema: [status, capture, replace, rollback],
    cantripOsSystemStatusResultSchema: [
      { supported: true, target, bases: [base], running: false, error: null },
      {
        supported: true,
        target: null,
        bases: [],
        running: true,
        error: "Unattached",
        enrollment: { containerId: cid, guestInstanceId: id },
      },
      {
        supported: false,
        target: null,
        bases: [],
        running: null,
        error: "No Docker management path",
      },
    ],
    cantripOsSystemOperationContextSchema: [context],
    cantripOsSystemProtectedOperationResultSchema: [envelope],
    cantripOsSystemRootReceiptSchema: [
      root,
      { ...root, guestInstanceId: null, guestAttachment: "unavailable" },
    ],
    cantripOsSystemOperationResultSchema: [
      result,
      { ...result, state: "unknown", protectedResult: null, root: null },
    ],
    cantripOsSystemPrivateOperationResultSchema: [
      {
        version: 1,
        command: capture,
        capture: null,
        replacement: null,
        diagnostic: "/private/雪",
      },
    ],
  };
}
