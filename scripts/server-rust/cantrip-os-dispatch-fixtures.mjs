const id = "12345678-1234-4234-8234-123456789abc";
export const osScope = {
  ownerId: "owner",
  workerId: "worker",
  serverId: "server",
  instanceId: id,
  guestInstanceId: id,
  attachmentGeneration: id,
  runtimeGeneration: id,
};
export const osSourceScope = {
  ...osScope,
  bindingId: id,
  bindingGeneration: id,
  projectId: "project",
  projectSourceId: id,
  sourceKind: "git",
  worktreeId: id,
  workspaceId: id,
  guestWorkspaceId: "example",
  uid: 20000,
  gid: 20000,
  homeGuestPath: "/home/example",
  guestPath: "/home/example/checkouts/source",
  dependencyOverlays: [],
  mode: "linux-owned",
  linkedWorkerPath: null,
};
export const osOpaque = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};
const transport = { kind: "docker", container: "cantrip-os" };
const backupWorkspace = {
  id,
  guestWorkspaceId: "example",
  uid: 20000,
  gid: 20000,
  homeGuestPath: "/home/example",
};
const backupRequest = {
  kind: "metadata",
  sequence: 1,
  envelope: osOpaque.envelope,
};
const runExecution = {
  kind: "cantrip-os",
  scope: Object.fromEntries(
    Object.entries({ ...osSourceScope, projectId: id }).filter(
      ([key]) => key !== "serverId",
    ),
  ),
  transport,
};
const runRoots = { definitions: runExecution, target: runExecution };
const runIdentity = {
  runtimeId: id,
  projectId: id,
  configurationId: id,
  worktreeId: id,
  workerId: "worker",
  definitionRevision: "a".repeat(64),
  codexEnvironmentRevision: null,
  generation: 1,
  operationId: id,
  terminalId: id,
};
const runLaunch = { ...runRoots, identity: runIdentity, protectedSecrets: [] };
const runCapture = { ...runRoots, identity: runIdentity };
export const osCommands = [
  { type: "cantrip-os.run-runtime.start", ...runLaunch },
  { type: "cantrip-os.run-runtime.restart", ...runLaunch },
  { type: "cantrip-os.run-runtime.stop", ...runCapture },
  { type: "cantrip-os.run-runtime.status", ...runCapture },
  {
    type: "cantrip-os.run-runtime.output",
    ...runCapture,
    requestOperationId: id,
    serverId: "server",
    tail: 1024,
  },
  { type: "cantrip-os.run-runtime.reconcile", captures: [runCapture] },
  {
    type: "cantrip-os.run-definition",
    execution: {
      kind: "cantrip-os",
      scope: Object.fromEntries(
        Object.entries({ ...osSourceScope, projectId: id }).filter(
          ([key]) => key !== "serverId",
        ),
      ),
      transport,
    },
    request: {
      type: "project.run-configuration-definitions.list",
      operationId: id,
      projectId: id,
    },
  },
  {
    type: "cantrip-os.inspect",
    ownerId: "owner",
    workerId: "worker",
    transport,
  },
  { type: "cantrip-os.attach", scope: osScope, transport },
  { type: "cantrip-os.workspaces.list", scope: osScope, transport },
  {
    type: "cantrip-os.workspaces.create",
    scope: osScope,
    transport,
    guestWorkspaceId: "example",
    operationId: id,
  },
  {
    type: "cantrip-os.source.provision",
    scope: osSourceScope,
    transport,
    operationId: id,
    protectedRequest: osOpaque,
  },
  {
    type: "cantrip-os.source.inspect",
    scope: osSourceScope,
    transport,
    sourceKind: "git",
  },
  { type: "cantrip-os.operation.inspect", scope: osScope, operationId: id },
  {
    type: "cantrip-os.backup.capture",
    scope: osScope,
    operationId: id,
    transport,
    workspace: backupWorkspace,
    sources: [],
    protectedRequest: backupRequest,
  },
  {
    type: "cantrip-os.backup.restore",
    scope: osScope,
    operationId: id,
    transport,
    workspace: backupWorkspace,
    backupId: id,
    backupScope: osScope,
    replace: false,
    protectedRequest: backupRequest,
  },
  {
    type: "cantrip-os.backup.rollback",
    scope: osScope,
    operationId: id,
    transport,
    workspace: backupWorkspace,
    restoreOperationId: id,
    protectedRequest: backupRequest,
  },
  {
    type: "cantrip-os.backup.observe",
    scope: osScope,
    operationId: id,
    action: "capture",
    mode: "observe",
  },
];
export function osDispatchFixtures() {
  const receipt = {
    bindingId: id,
    workspaceId: id,
    guestWorkspaceId: "example",
    mode: "linux-owned",
    guestPath: osSourceScope.guestPath,
    runtimeGeneration: id,
    uid: 20000,
    homeGuestPath: osSourceScope.homeGuestPath,
    head: null,
    branch: null,
    detached: false,
    repositoryFingerprint: null,
    gitCommonGuestPath: null,
    recreated: false,
    interruptedGuestWorkspaces: [],
    dependencyOverlays: [],
    cleanupWarnings: [],
  };
  const intent = {
    mode: "linux-owned",
    source: {
      kind: "git",
      repositoryUrl: "https://example.invalid/repository.git",
      revision: "a".repeat(40),
    },
  };
  const linked = {
    ...osSourceScope,
    mode: "linked",
    linkedWorkerPath: "ctrr:private",
  };
  const { serverId: _server, ...executionScope } = osSourceScope;
  const { serverId: _linkedServer, ...linkedExecutionScope } = linked;
  const fixtures = {
    cantripOsRunSelectionSchema: [
      {
        kind: "binding",
        bindingId: id,
        bindingGeneration: id,
        attachmentGeneration: id,
        runtimeGeneration: id,
      },
      { kind: "runtime", runtimeId: id },
    ],
    cantripOsRunSourceSchema: [
      {
        binding: {
          id,
          ownerId: "owner",
          workerId: "worker",
          projectId: "project",
          projectSourceId: id,
          worktreeId: id,
          instanceId: id,
          workspaceId: id,
          mode: "linux-owned",
          linkedWorkerPath: null,
          guestPath: osSourceScope.guestPath,
          bindingGeneration: id,
          provisionedAttachmentGeneration: id,
          provisionedRuntimeGeneration: id,
          state: "ready",
          lastError: null,
          dependencyOverlays: [],
          createdAt: "2026-11-04T00:00:00.000Z",
          updatedAt: "2026-11-04T00:00:00.000Z",
        },
        instance: {
          id,
          ownerId: "owner",
          workerId: "worker",
          guestInstanceId: id,
          attachmentGeneration: id,
          name: "Fixture",
          status: "connected",
          runtimeGeneration: id,
          lastError: null,
          lastObservedAt: null,
          createdAt: "2026-11-04T00:00:00.000Z",
          updatedAt: "2026-11-04T00:00:00.000Z",
        },
        workspace: {
          id,
          instanceId: id,
          workerId: "worker",
          guestWorkspaceId: "example",
          uid: 20000,
          gid: 20000,
          homeGuestPath: "/home/example",
          createdAt: "2026-11-04T00:00:00.000Z",
          updatedAt: "2026-11-04T00:00:00.000Z",
        },
        target: {
          id,
          workerId: "worker",
          isPrimary: true,
          isDefault: true,
          name: "Primary",
          branch: "main",
          lifecycleState: "ready",
          displayPath: osSourceScope.guestPath,
        },
        available: true,
      },
    ],
    cantripOsRunRootsSchema: [runRoots],
    cantripOsRunLaunchSchema: [runLaunch],
    cantripOsRunCaptureSchema: [runCapture],
    cantripOsRunDefinitionRequestSchema: [
      {
        type: "project.run-configuration-definitions.list",
        operationId: id,
        projectId: id,
      },
    ],
    cantripOsRunDefinitionApiSchema: [
      {
        runtimeGeneration: id,
        request: {
          type: "project.run-configuration-definitions.list",
          operationId: id,
          projectId: id,
        },
      },
    ],
    cantripOsRunPrimarySchema: [
      {
        bindingId: id,
        worktreeId: id,
        projectSourceId: id,
        runtimeGeneration: id,
        guestPath: "/home/example/primary",
      },
    ],
    cantripOsRunDefinitionResponseSchema: [
      {
        source: {
          bindingId: id,
          worktreeId: id,
          projectSourceId: id,
          runtimeGeneration: id,
          guestPath: "/home/example/primary",
        },
        result: {
          operation: "capabilities",
          operationId: id,
          projectId: id,
          capabilities: [],
        },
      },
    ],
    cantripOsExecutionScopeSchema: [executionScope, linkedExecutionScope],
    cantripOsExecutionSchema: [
      { kind: "cantrip-os", scope: executionScope, transport },
      { kind: "cantrip-os", scope: linkedExecutionScope, transport },
    ],
    cantripOsDispatchScopeSchema: [osScope],
    cantripOsBackupWorkspaceSchema: [backupWorkspace],
    cantripOsBackupSourceSchema: [
      {
        bindingId: id,
        projectId: "project",
        projectSourceId: id,
        worktreeId: id,
        mode: "linux-owned",
        guestPath: "/home/example/checkouts/source",
        gitCommonGuestPath: null,
      },
    ],
    cantripOsBackupPrivateRequestSchema: [
      {
        action: "capture",
        workspaceId: id,
        label: "Private 日本",
        exclusions: ["repo/node_modules"],
      },
      { action: "restore", workspaceId: id, backupId: id, replace: false },
      { action: "rollback", workspaceId: id, restoreOperationId: id },
    ],
    cantripOsBackupPrivateResultSchema: [
      {
        action: "error",
        operationAction: "restore",
        message: "Private recovery diagnostic",
      },
      {
        action: "capture",
        metadata: {
          version: 1,
          archiveBytes: 10240,
          archiveSha256: "a".repeat(64),
          manifest: {},
        },
        cleanupWarnings: [],
      },
      { action: "restore", backupId: id, receipt: {}, cleanupWarnings: [] },
      {
        action: "rollback",
        restoreOperationId: id,
        receipt: {},
        cleanupWarnings: [],
      },
    ],
    cantripOsBackupOperationResultSchema: [
      {
        operationId: id,
        action: "capture",
        state: "ready",
        phase: "complete",
        startedAt: "2026-11-05T00:00:00.000Z",
        updatedAt: "2026-11-05T00:01:00.000Z",
        protectedResult: { ...backupRequest, sequence: 2 },
        error: null,
      },
      {
        operationId: id,
        action: "restore",
        state: "unknown",
        phase: "recovery-required",
        startedAt: null,
        updatedAt: "2026-11-05T00:01:00.000Z",
        protectedResult: null,
        error: "Observe the saved admission",
      },
    ],
    cantripOsSourceDispatchScopeSchema: [
      osSourceScope,
      { ...osSourceScope, repositoryFingerprint: "fingerprint" },
      linked,
    ],
    cantripOsProvisionIntentSchema: [
      intent,
      {
        mode: "linux-owned",
        source: {
          kind: "git-worktree",
          revision: "a".repeat(40),
          branch: "test/日本",
        },
      },
      {
        mode: "linux-owned",
        source: {
          kind: "git-worktree",
          revision: "a".repeat(40),
          branch: null,
        },
      },
      { mode: "linux-owned", source: { kind: "folder" } },
      {
        mode: "linked",
        workerPath: "ctrr:private",
        dependencyOverlays: [{ path: "node_modules" }],
      },
    ],
    cantripOsProvisionRequestContentSchema: [
      {
        type: "cantrip-os.source.provision",
        instanceId: id,
        workspaceId: id,
        bindingId: id,
        bindingGeneration: id,
        intent,
      },
    ],
    cantripOsObservedInstanceSchema: [
      {
        guestInstanceId: id,
        runtimeGeneration: id,
        attachment: { ownerId: "owner", workerId: "worker" },
        workspaces: [],
      },
    ],
    cantripOsSourceReceiptSchema: [receipt],
    cantripOsOperationResultSchema: [
      {
        operationId: id,
        startedAt: "2026-11-03T00:00:00.000Z",
        updatedAt: "2026-11-03T00:00:00.000Z",
        state: "ready",
        error: null,
        receipt: { kind: "source", source: receipt },
      },
      {
        operationId: id,
        startedAt: "2026-11-03T00:00:00.000Z",
        updatedAt: "2026-11-03T00:00:00.000Z",
        state: "unknown",
        error: "Delivery unknown",
        receipt: null,
      },
    ],
    cantripOsInspectSchema: [{ workerId: "worker", transport }],
    cantripOsRecoveryRequestSchema: [
      { attachmentGeneration: id, runtimeGeneration: id },
      { attachmentGeneration: id, runtimeGeneration: null },
    ],
    cantripOsWorkspaceCreateSchema: [
      { guestWorkspaceId: "example", operationId: id },
    ],
    cantripOsBindingCreateSchema: [
      { mode: "linux-owned", workspaceId: id, sourceKind: "git" },
      {
        mode: "linux-worktree",
        sourceBindingId: id,
        expectedRuntimeGeneration: id,
        operationId: id,
      },
      {
        mode: "linked",
        workspaceId: id,
        worktreeId: id,
        dependencyOverlays: [],
      },
    ],
    cantripOsProvisionSchema: [
      { operationId: id, bindingGeneration: id, protectedRequest: osOpaque },
    ],
  };
  fixtures.cantripOsRecoveryResultSchema = [
    ["same-runtime", id, id],
    ["runtime-changed", id, "new-runtime"],
    ["first-observation", null, id],
    ["unavailable", id, null],
    ["identity-changed", id, null],
  ].flatMap(([kind, previousRuntimeGeneration, observedRuntimeGeneration]) =>
    [
      ["same-worker", id, id],
      ["worker-restarted", id, "new-worker"],
      ["first-observation", null, id],
      ["unavailable", id, null],
    ].map(
      ([
        workerContinuity,
        previousWorkerProcessGeneration,
        observedWorkerProcessGeneration,
      ]) => ({
        instance: {
          ...fixtures.cantripOsRunSourceSchema[0].instance,
          status: observedRuntimeGeneration ? "connected" : "unknown",
        },
        workspaces: observedRuntimeGeneration
          ? [fixtures.cantripOsRunSourceSchema[0].workspace]
          : [],
        recovery: {
          kind,
          previousRuntimeGeneration,
          observedRuntimeGeneration,
          workerContinuity,
          previousWorkerProcessGeneration,
          observedWorkerProcessGeneration,
          message: "Recovery fixture",
        },
      }),
    ),
  );
  return fixtures;
}
