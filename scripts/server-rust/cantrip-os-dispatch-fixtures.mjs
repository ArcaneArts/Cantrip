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
  return {
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
}
