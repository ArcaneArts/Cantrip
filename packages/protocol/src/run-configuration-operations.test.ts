import { describe, expect, it } from "vitest";

import { workerCommandSchema, workerNotificationSchema } from "./index.js";

import {
  runConfigurationApiValidateRequestSchema,
  runConfigurationApiFlutterDevicesRequestSchema,
  runConfigurationApiWriteRequestSchema,
  runConfigurationCapabilitiesResponseSchema,
  runConfigurationCapabilitiesWorkerCommandSchema,
  runConfigurationDefinitionChangeNotificationSchema,
  runConfigurationDeleteWorkerCommandSchema,
  runConfigurationDetectResponseSchema,
  runConfigurationDetectWorkerCommandSchema,
  runConfigurationGetWorkerCommandSchema,
  runConfigurationGetResponseSchema,
  runConfigurationFlutterDevicesResponseSchema,
  runConfigurationFlutterDevicesWorkerCommandSchema,
  runConfigurationListResponseSchema,
  runConfigurationListWorkerCommandSchema,
  runConfigurationPathsQuerySchema,
  runConfigurationPathsResponseSchema,
  runConfigurationPathsWorkerCommandSchema,
  runConfigurationValidateResponseSchema,
  runConfigurationValidateWorkerCommandSchema,
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
const flutterDocument = {
  ...document,
  name: "Run mobile",
  provider: "flutter" as const,
  workingDirectory: "apps/mobile",
  target: { kind: "entrypoint" as const, path: "lib/main.dart" },
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
      runConfigurationFlutterDevicesWorkerCommandSchema.parse({
        type: "project.run-configuration-definitions.flutter-devices",
        ...context,
        document: flutterDocument,
      }).document.provider,
    ).toBe("flutter");
    expect(
      runConfigurationValidateWorkerCommandSchema.parse({
        type: "project.run-configuration-definitions.validate",
        ...context,
        document,
      }).document.id,
    ).toBe(configurationId);
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
        type: "project.run-configuration-definitions.flutter-devices",
        ...context,
        document: flutterDocument,
      }).type,
    ).toBe("project.run-configuration-definitions.flutter-devices");
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
    expect(
      workerCommandSchema.parse({
        type: "project.run-configuration-definitions.validate",
        ...context,
        document,
      }).type,
    ).toBe("project.run-configuration-definitions.validate");
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
        validations: [],
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

  it("correlates one provider validation with every ready listed definition", () => {
    const entry = {
      relativePath: `.cantrip/run-configurations/${configurationId}.json`,
      revision: "a".repeat(64),
      id: configurationId,
      status: "ready" as const,
      document,
      diagnostics: [],
    };
    const validation = {
      configurationId,
      provider: "shell" as const,
      platform: "linux" as const,
      effectiveCommand: "pnpm dev",
      valid: true,
      diagnostics: [],
    };
    const response = {
      operation: "list" as const,
      operationId,
      projectId,
      inventory: {
        directory: ".cantrip/run-configurations" as const,
        entries: [entry],
        diagnostics: [],
      },
      validations: [validation],
    };

    expect(
      runConfigurationListResponseSchema.parse(response).validations,
    ).toEqual([
      expect.objectContaining({
        configurationId,
        provider: "shell",
        valid: true,
      }),
    ]);
    expect(
      runConfigurationListResponseSchema.safeParse({
        ...response,
        validations: [],
      }).success,
    ).toBe(false);
    expect(
      runConfigurationListResponseSchema.safeParse({
        ...response,
        validations: [validation, validation],
      }).success,
    ).toBe(false);
    expect(
      runConfigurationListResponseSchema.safeParse({
        ...response,
        validations: [{ ...validation, provider: "node" }],
      }).success,
    ).toBe(false);
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
    expect(
      runConfigurationApiValidateRequestSchema.safeParse({
        operationId,
        document,
        plaintextSecret: "never",
      }).success,
    ).toBe(false);
  });

  it("correlates provider validation and derives validity from diagnostics", () => {
    const validation = runConfigurationValidateResponseSchema.parse({
      operation: "validate",
      operationId,
      projectId,
      validation: {
        configurationId,
        provider: "shell",
        platform: "linux",
        effectiveCommand: "pnpm dev",
        valid: true,
        diagnostics: [],
      },
    });
    expect(validation.validation).toMatchObject({
      platform: "linux",
      valid: true,
    });
    expect(
      runConfigurationValidateResponseSchema.safeParse({
        ...validation,
        validation: {
          ...validation.validation,
          diagnostics: [
            {
              severity: "error",
              code: "target-missing",
              message: "The selected target is missing.",
              relativePath: null,
              field: "target",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("correlates strict bounded Flutter device inspection", () => {
    expect(
      runConfigurationApiFlutterDevicesRequestSchema.parse({
        operationId,
        document: flutterDocument,
      }).document.provider,
    ).toBe("flutter");
    const response = runConfigurationFlutterDevicesResponseSchema.parse({
      operation: "flutter-devices",
      operationId,
      projectId,
      configurationId,
      platform: "linux",
      devices: [
        {
          id: "emulator-5554",
          name: "Pixel 9",
          supported: true,
          emulator: true,
          targetPlatform: "android-arm64",
        },
      ],
      diagnostics: [],
    });
    expect(response.devices[0]).toMatchObject({
      id: "emulator-5554",
      emulator: true,
    });
    expect(
      runConfigurationFlutterDevicesResponseSchema.safeParse({
        ...response,
        devices: [{ ...response.devices[0], secret: "not-public" }],
      }).success,
    ).toBe(false);
    expect(
      runConfigurationApiFlutterDevicesRequestSchema.safeParse({
        operationId,
        document,
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
