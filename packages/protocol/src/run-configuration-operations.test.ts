import { describe, expect, it } from "vitest";

import { workerCommandSchema, workerNotificationSchema } from "./index.js";

import {
  runConfigurationApiWriteRequestSchema,
  runConfigurationCapabilitiesResponseSchema,
  runConfigurationCapabilitiesWorkerCommandSchema,
  runConfigurationDefinitionChangeNotificationSchema,
  runConfigurationDeleteWorkerCommandSchema,
  runConfigurationDetectResponseSchema,
  runConfigurationDetectWorkerCommandSchema,
  runConfigurationGetWorkerCommandSchema,
  runConfigurationGetResponseSchema,
  runConfigurationListResponseSchema,
  runConfigurationListWorkerCommandSchema,
  runConfigurationPathsQuerySchema,
  runConfigurationPathsResponseSchema,
  runConfigurationPathsWorkerCommandSchema,
  runConfigurationWriteWorkerCommandSchema,
} from "./run-configuration-operations.js";

const operationId = "b455011d-47c5-478a-a74c-3d2635511263";
const projectId = "f288701f-e4a6-4d08-bd54-eddb41aadbe5";
const configurationId = "0f82c573-704d-4a06-984e-5ce0b8d688ca";
const context = { operationId, projectId, sourcePath: "/workspace/project" };
const document = {
  schema: "cantrip.run-configuration" as const,
  version: 1 as const,
  id: configurationId,
  name: "Run API",
  provider: "shell" as const,
  target: { kind: "command" as const, command: "pnpm dev" },
};

describe("run configuration operation protocol", () => {
  it("defines strict bounded worker commands for every repository operation", () => {
    expect(
      runConfigurationListWorkerCommandSchema.parse({
        type: "project.run-configuration-definitions.list",
        ...context,
      }).type,
    ).toBe("project.run-configuration-definitions.list");
    expect(
      runConfigurationGetWorkerCommandSchema.parse({
        type: "project.run-configuration-definitions.get",
        ...context,
        configurationId,
      }).configurationId,
    ).toBe(configurationId);
    expect(
      runConfigurationCapabilitiesWorkerCommandSchema.parse({
        type: "project.run-configuration-definitions.capabilities",
        ...context,
      }).type,
    ).toContain("capabilities");
    expect(
      runConfigurationDetectWorkerCommandSchema.parse({
        type: "project.run-configuration-definitions.detect",
        ...context,
        providerKind: "node",
      }).providerKind,
    ).toBe("node");
    expect(
      runConfigurationPathsWorkerCommandSchema.parse({
        type: "project.run-configuration-definitions.paths",
        ...context,
        purpose: "shell-script",
        query: "scripts/dev",
      }).purpose,
    ).toBe("shell-script");
    expect(
      runConfigurationWriteWorkerCommandSchema.parse({
        type: "project.run-configuration-definitions.write",
        ...context,
        request: { expectedRevision: null, document },
      }).request.document.id,
    ).toBe(configurationId);
    expect(
      runConfigurationDeleteWorkerCommandSchema.parse({
        type: "project.run-configuration-definitions.delete",
        ...context,
        request: { id: configurationId, expectedRevision: "a".repeat(64) },
      }).request.id,
    ).toBe(configurationId);
    expect(
      workerCommandSchema.parse({
        type: "project.run-configuration-definitions.list",
        ...context,
      }).type,
    ).toBe("project.run-configuration-definitions.list");
    expect(
      workerCommandSchema.parse({
        type: "project.run-configuration-definitions.detect",
        ...context,
        providerKind: null,
      }).type,
    ).toBe("project.run-configuration-definitions.detect");
    expect(
      workerCommandSchema.parse({
        type: "project.run-configuration-definitions.paths",
        ...context,
        purpose: "directory",
        query: "packages",
      }).type,
    ).toBe("project.run-configuration-definitions.paths");
  });

  it("correlates bounded responses and watcher notifications", () => {
    expect(
      runConfigurationListResponseSchema.parse({
        operation: "list",
        operationId,
        projectId,
        inventory: {
          directory: ".cantrip/run-configurations",
          entries: [],
          diagnostics: [],
        },
      }).operationId,
    ).toBe(operationId);
    expect(
      runConfigurationGetResponseSchema.parse({
        operation: "get",
        operationId,
        projectId,
        result: { found: false, id: configurationId },
        secretReferences: [],
        codexEnvironment: {
          enabled: false,
          configured: false,
          valid: true,
          revision: null,
          hasSetup: false,
          diagnostics: [],
        },
      }).codexEnvironment,
    ).toMatchObject({ configured: false, revision: null });
    expect(
      runConfigurationDefinitionChangeNotificationSchema.parse({
        type: "project.run-configuration-definitions.changed",
        projectId,
        sourcePath: "/workspace/project",
        change: {
          kind: "created",
          id: configurationId,
          relativePath: `.cantrip/run-configurations/${configurationId}.json`,
          revision: "b".repeat(64),
        },
      }).change.kind,
    ).toBe("created");
    expect(
      workerNotificationSchema.parse({
        type: "project.run-configuration-definitions.changed",
        projectId,
        sourcePath: "/workspace/project",
        change: {
          kind: "deleted",
          id: configurationId,
          relativePath: `.cantrip/run-configurations/${configurationId}.json`,
          revision: null,
        },
      }).type,
    ).toBe("project.run-configuration-definitions.changed");
  });

  it("rejects duplicate capabilities and unknown authoring fields", () => {
    const shell = {
      provider: "shell" as const,
      label: "Shell",
      icon: "terminal",
      available: true,
      supportsDiscovery: false,
      supportsCommandOverride: true,
      supportsBeforeLaunch: true,
      supportsPlatformOverrides: true,
    };
    expect(
      runConfigurationCapabilitiesResponseSchema.safeParse({
        operation: "capabilities",
        operationId,
        projectId,
        capabilities: [shell, shell],
      }).success,
    ).toBe(false);
    expect(
      runConfigurationApiWriteRequestSchema.safeParse({
        operationId,
        expectedRevision: null,
        document,
        plaintextSecret: "never",
      }).success,
    ).toBe(false);
  });

  it("correlates bounded typed detection results", () => {
    const detected = runConfigurationDetectResponseSchema.parse({
      operation: "detect",
      operationId,
      projectId,
      candidates: [
        {
          provider: "node",
          confidence: "high",
          reason: "The package defines a start script.",
          effectiveCommand: "pnpm run start",
          document: {
            schema: "cantrip.run-configuration",
            version: 1,
            id: configurationId,
            name: "Run app",
            provider: "node",
            target: { kind: "packageScript", script: "start" },
            options: { packageManager: "pnpm" },
          },
        },
      ],
      diagnostics: [],
    });
    expect(detected.candidates[0]).toMatchObject({
      provider: "node",
      document: { environment: { includeCodexEnvironment: true } },
    });
  });

  it("correlates strict bounded path discovery", () => {
    expect(
      runConfigurationPathsQuerySchema.parse({
        operationId,
        purpose: "environment-file",
      }),
    ).toMatchObject({ query: "" });
    const paths = runConfigurationPathsResponseSchema.parse({
      operation: "paths",
      operationId,
      projectId,
      purpose: "directory",
      query: "src",
      suggestions: [
        { kind: "directory", path: "src" },
        { kind: "directory", path: "packages/api/src" },
      ],
      truncated: false,
    });
    expect(paths.suggestions).toHaveLength(2);
    expect(
      runConfigurationPathsResponseSchema.safeParse({
        ...paths,
        suggestions: [{ kind: "file", path: "." }],
      }).success,
    ).toBe(false);
    expect(
      runConfigurationPathsQuerySchema.safeParse({
        operationId,
        purpose: "file",
        query: "bad\0query",
      }).success,
    ).toBe(false);
  });
});
