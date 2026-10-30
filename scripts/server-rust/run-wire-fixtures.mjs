import { runDefinition } from "./run-definition-fixture.mjs";
import { runConfigurationFlutterDocumentSchema } from "../../packages/protocol/dist/run-configuration-definitions.js";

// Concrete protocol inputs. Expected values/issues are always produced by the
// real exported TypeScript schemas in security-oracle, never by native metadata.
export function runWireFixtures(protectedValue) {
  const ids = Array.from(
    { length: 6 },
    (_, i) =>
      `${String(i + 1).repeat(8)}-${String(i + 1).repeat(4)}-4${String(i + 1).repeat(3)}-8${String(i + 1).repeat(3)}-${String(i + 1).repeat(12)}`,
  );
  const [
    runtimeId,
    projectId,
    configurationId,
    worktreeId,
    operationId,
    terminalId,
  ] = ids;
  const at = "2026-10-25T00:00:00.000Z",
    revision = "a".repeat(64),
    workerId = "run-fixture-worker";
  const protectedOutput = { domain: "run-content", ...protectedValue };
  const context = { operationId, projectId };
  const get = runDefinition({ ...context, configurationId });
  const entry = get.result.entry,
    document = entry.document;
  const flutter = runConfigurationFlutterDocumentSchema.parse({
    schema: "cantrip.run-configuration",
    version: 1,
    id: configurationId,
    name: "Flutter acceptance",
    provider: "flutter",
    target: { kind: "entrypoint", path: "lib/main.dart" },
  });
  const validation = {
    configurationId,
    provider: "shell",
    platform: "linux",
    effectiveCommand: "echo acceptance",
    valid: true,
    diagnostics: [],
  };
  const secret = {
    reference: "run/api",
    available: true,
    revision: 1,
    updatedAt: at,
  };
  const identity = {
    runtimeId,
    projectId,
    configurationId,
    worktreeId,
    workerId,
    definitionRevision: revision,
    codexEnvironmentRevision: null,
    generation: 1,
    operationId,
    terminalId,
  };
  const runtime = {
    id: runtimeId,
    projectId,
    configurationId,
    worktreeId,
    workerId,
    terminalId,
    definitionRevision: revision,
    codexEnvironmentRevision: null,
    generation: 1,
    requestedOperationId: operationId,
    state: "running",
    startedAt: at,
    endedAt: null,
    exitCode: null,
    signal: null,
    failure: null,
    createdAt: at,
    updatedAt: at,
  };
  const observation = {
    ...identity,
    state: "running",
    startedAt: at,
    endedAt: null,
    exitCode: null,
    signal: null,
    failure: null,
  };
  const operation = {
    id: operationId,
    projectId,
    configurationId,
    worktreeId,
    runtimeId,
    workerId,
    operation: "start",
    outcome: "accepted",
    generation: 1,
    definitionRevision: revision,
    codexEnvironmentRevision: null,
    createdAt: at,
  };
  return {
    runConfigurationRuntimeLifecycleRequestSchema: [
      {
        operation: "start",
        ...context,
        configurationId,
        targetWorktreeId: worktreeId,
      },
      {
        operation: "stop",
        ...context,
        configurationId,
        targetWorktreeId: null,
      },
    ],
    runConfigurationRuntimeOperationResultSchema: [
      { operation, replayed: false, runtime },
    ],
    runConfigurationGetResponseSchema: [get],
    runConfigurationListQuerySchema: [{ operationId }],
    runConfigurationDetectQuerySchema: [{ operationId, provider: "shell" }],
    runConfigurationPathsQuerySchema: [
      { operationId, purpose: "directory", query: "src" },
    ],
    runConfigurationApiValidateRequestSchema: [{ operationId, document }],
    runConfigurationApiFlutterDevicesRequestSchema: [
      { operationId, document: flutter },
    ],
    runConfigurationApiWriteRequestSchema: [
      { operationId, expectedRevision: revision, document },
    ],
    runConfigurationApiDeleteRequestSchema: [
      { operationId, expectedRevision: revision },
    ],
    runConfigurationListResponseSchema: [
      {
        operation: "list",
        ...context,
        inventory: {
          directory: ".cantrip/run-configurations",
          entries: [entry],
          diagnostics: [],
        },
        validations: [validation],
      },
    ],
    runConfigurationCapabilitiesResponseSchema: [
      {
        operation: "capabilities",
        ...context,
        capabilities: [
          {
            provider: "shell",
            label: "Shell",
            icon: "terminal",
            available: true,
            supportsDiscovery: true,
            supportsCommandOverride: true,
            supportsBeforeLaunch: true,
            supportsPlatformOverrides: true,
          },
        ],
      },
    ],
    runConfigurationDetectResponseSchema: [
      {
        operation: "detect",
        ...context,
        candidates: [
          {
            provider: "shell",
            confidence: "high",
            reason: "Script discovered",
            effectiveCommand: "echo acceptance",
            document,
          },
        ],
        diagnostics: [],
      },
    ],
    runConfigurationPathsResponseSchema: [
      {
        operation: "paths",
        ...context,
        purpose: "directory",
        query: "src",
        suggestions: [{ kind: "directory", path: "src" }],
        truncated: false,
      },
    ],
    runConfigurationValidateResponseSchema: [
      { operation: "validate", ...context, validation },
    ],
    runConfigurationFlutterDevicesResponseSchema: [
      {
        operation: "flutter-devices",
        ...context,
        configurationId,
        platform: "linux",
        devices: [
          {
            id: "device",
            name: "Fixture device",
            supported: true,
            emulator: false,
            targetPlatform: "linux-x64",
          },
        ],
        diagnostics: [],
      },
    ],
    runConfigurationWriteResponseSchema: [
      { operation: "write", ...context, result: { outcome: "created", entry } },
      {
        operation: "write",
        ...context,
        result: {
          outcome: "revision-mismatch",
          id: configurationId,
          currentRevision: revision,
          conflictingId: null,
        },
      },
    ],
    runConfigurationDeleteResponseSchema: [
      {
        operation: "delete",
        ...context,
        result: { outcome: "deleted", id: configurationId, revision },
      },
      {
        operation: "delete",
        ...context,
        result: {
          outcome: "not-found",
          id: configurationId,
          currentRevision: null,
        },
      },
    ],
    runConfigurationIdSchema: [configurationId],
    runConfigurationProtectedSecretListSchema: [
      [{ reference: "run/api", revision: 1, protectedValue }],
    ],
    runConfigurationSecretSummaryListSchema: [
      [
        secret,
        {
          reference: "run/missing",
          available: false,
          revision: null,
          updatedAt: null,
        },
      ],
    ],
    runConfigurationSecretListResultSchema: [{ projectId, secrets: [secret] }],
    runConfigurationSecretSetRequestSchema: [
      { operationId, reference: "run/api", protectedValue },
    ],
    runConfigurationSecretSetResultSchema: [
      { ...context, replayed: false, secret },
    ],
    runConfigurationRuntimeStatusQuerySchema: [
      { ...context, configurationId, targetWorktreeId: worktreeId, limit: 10 },
    ],
    runConfigurationRuntimeStatusResultSchema: [
      { ...context, runtimes: [runtime] },
    ],
    runConfigurationRuntimeOutputQuerySchema: [
      { ...context, configurationId, worktreeId, tail: 100 },
    ],
    protectedRunConfigurationRuntimeWorkerOutputSchema: [
      { requestOperationId: operationId, identity, protectedOutput },
    ],
    protectedRunConfigurationRuntimeOutputResultSchema: [
      {
        ...context,
        configurationId,
        worktreeId,
        generation: 1,
        protectedOutput,
      },
    ],
    runConfigurationRuntimeWorkerOperationResultSchema: [
      { outcome: "accepted", observation },
      { outcome: "not-found", observation: null },
    ],
    runConfigurationRuntimeWorkerObservationSchema: [
      observation,
      {
        ...observation,
        state: "failed",
        endedAt: at,
        exitCode: 1,
        failure: {
          phase: "spawn",
          code: "spawn-failed",
          message: "Fixture spawn failed",
          retryable: false,
        },
      },
    ],
    runConfigurationRuntimeWorkerReconciliationSchema: [
      {
        runtimes: [
          { found: true, observation },
          { found: false, identity },
        ],
        orphanedRuntimeIds: [runtimeId],
      },
    ],
  };
}
