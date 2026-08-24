import { describe, expect, it } from "vitest";

import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
  runConfigurationDetectionCandidateSchema,
  runConfigurationFileSchema,
  runConfigurationProviderCapabilitySchema,
  runConfigurationProviderKindSchema,
  runConfigurationRepositoryInventorySchema,
  runConfigurationRepositoryPathSchema,
  runConfigurationSecretReferenceSchema,
  runConfigurationWorkingDirectorySchema,
  runConfigurationWriteRequestSchema,
} from "./run-configuration-definitions.js";

const configurationId = "0f82c573-704d-4a06-984e-5ce0b8d688ca";

function shellConfiguration() {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1 as const,
    id: configurationId,
    name: "Run API",
    provider: "shell" as const,
    target: {
      kind: "command" as const,
      command: "pnpm --filter @cantrip/server dev",
    },
  };
}

function nodeConfiguration() {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1 as const,
    id: configurationId,
    name: "Run web",
    provider: "node" as const,
    workingDirectory: "packages/web",
    target: { kind: "packageScript" as const, script: "dev" },
  };
}

describe("run configuration definition protocol", () => {
  it("normalizes a minimal Shell definition with safe defaults", () => {
    expect(runConfigurationFileSchema.parse(shellConfiguration())).toEqual({
      ...shellConfiguration(),
      workingDirectory: ".",
      commandOverride: null,
      arguments: [],
      environment: {
        includeCodexEnvironment: true,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: [],
      platformOverrides: {},
      options: { shell: "automatic", login: true },
      stop: { gracePeriodMs: 3_000 },
    });
    expect(
      runConfigurationFileSchema.parse({
        ...shellConfiguration(),
        arguments: ["--listen", "127.0.0.1:4400"],
      }).arguments,
    ).toEqual(["--listen", "127.0.0.1:4400"]);
  });

  it("declares every planned provider while admitting implemented typed documents", () => {
    expect(runConfigurationProviderKindSchema.options).toEqual([
      "shell",
      "node",
      "java",
      "dart",
      "flutter",
      "rust",
    ]);
    expect(
      runConfigurationFileSchema.safeParse({
        ...shellConfiguration(),
        provider: "rust",
      }).success,
    ).toBe(false);
    expect(runConfigurationFileSchema.parse(nodeConfiguration())).toMatchObject(
      {
        provider: "node",
        workingDirectory: "packages/web",
        target: { kind: "packageScript", script: "dev" },
        options: {
          packageManager: "npm",
          runtime: "node",
          runtimeArguments: [],
        },
        environment: { includeCodexEnvironment: true },
      },
    );
    expect(
      runConfigurationProviderCapabilitySchema.parse({
        provider: "rust",
        label: "Rust",
        icon: "package",
        available: false,
        supportsDiscovery: true,
        supportsCommandOverride: true,
        supportsBeforeLaunch: true,
        supportsPlatformOverrides: true,
      }),
    ).toMatchObject({ provider: "rust", available: false });
  });

  it("keeps Node targets and detection candidates strict and provider-correlated", () => {
    expect(
      runConfigurationFileSchema.safeParse({
        ...nodeConfiguration(),
        target: { kind: "entry", path: "../outside.js" },
      }).success,
    ).toBe(false);
    expect(
      runConfigurationFileSchema.safeParse({
        ...nodeConfiguration(),
        options: {
          packageManager: "pnpm",
          runtime: "node",
          runtimeArguments: [],
          executable: "arbitrary",
        },
      }).success,
    ).toBe(false);
    const document = runConfigurationFileSchema.parse(nodeConfiguration());
    expect(
      runConfigurationDetectionCandidateSchema.parse({
        provider: "node",
        confidence: "high",
        reason: "The package defines a dev script.",
        effectiveCommand: "npm run dev",
        document,
      }).document.provider,
    ).toBe("node");
    expect(
      runConfigurationDetectionCandidateSchema.safeParse({
        provider: "shell",
        confidence: "high",
        reason: "Mismatched",
        effectiveCommand: "npm run dev",
        document,
      }).success,
    ).toBe(false);
  });

  it("rejects traversal, absolute paths, Windows paths, and NULs", () => {
    for (const invalid of [
      "../outside",
      "src/../outside",
      "/absolute",
      "C:\\outside",
      "nested\\windows",
      "nested//empty",
      "nested/./dot",
      "nul\0path",
    ]) {
      expect(
        runConfigurationRepositoryPathSchema.safeParse(invalid).success,
        invalid,
      ).toBe(false);
      expect(
        runConfigurationWorkingDirectorySchema.safeParse(invalid).success,
        invalid,
      ).toBe(false);
    }
    expect(runConfigurationWorkingDirectorySchema.parse(".")).toBe(".");
    expect(runConfigurationRepositoryPathSchema.parse(".env")).toBe(".env");
    expect(runConfigurationRepositoryPathSchema.parse("bin/server.sh")).toBe(
      "bin/server.sh",
    );
  });

  it("keeps secret values out of the document and rejects duplicate environment names", () => {
    const withSecret = runConfigurationFileSchema.parse({
      ...shellConfiguration(),
      environment: {
        secrets: [
          {
            name: "DATABASE_URL",
            secret: "project/database-url",
          },
        ],
      },
    });
    expect(withSecret.environment.secrets).toEqual([
      {
        name: "DATABASE_URL",
        secret: "project/database-url",
        enabled: true,
      },
    ]);
    expect(JSON.stringify(withSecret)).not.toContain("secretValue");

    expect(
      runConfigurationFileSchema.safeParse({
        ...shellConfiguration(),
        environment: {
          variables: [{ name: "PORT", value: "4400" }],
          secrets: [{ name: "port", secret: "project/port" }],
        },
      }).success,
    ).toBe(false);
    expect(
      runConfigurationSecretReferenceSchema.safeParse("../database-url")
        .success,
    ).toBe(false);
    expect(
      runConfigurationSecretReferenceSchema.safeParse("project/./database-url")
        .success,
    ).toBe(false);
  });

  it("applies strict versioned authoring and repository boundaries", () => {
    expect(
      runConfigurationFileSchema.safeParse({
        ...shellConfiguration(),
        version: 2,
      }).success,
    ).toBe(false);
    expect(
      runConfigurationFileSchema.safeParse({
        ...shellConfiguration(),
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      runConfigurationFileSchema.safeParse({
        ...shellConfiguration(),
        target: { kind: "command", command: "echo before\0after" },
      }).success,
    ).toBe(false);
    expect(
      runConfigurationFileSchema.safeParse({
        ...shellConfiguration(),
        beforeLaunch: Array.from({ length: 6 }, () => ({
          kind: "command",
          command: "x".repeat(100_000),
        })),
      }).success,
    ).toBe(false);

    expect(
      runConfigurationRepositoryInventorySchema.parse({
        directory: RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
        entries: [],
        diagnostics: [],
      }),
    ).toEqual({
      directory: RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
      entries: [],
      diagnostics: [],
    });
    expect(
      runConfigurationWriteRequestSchema.parse({
        expectedRevision: null,
        document: shellConfiguration(),
      }).document.environment.includeCodexEnvironment,
    ).toBe(true);
  });
});
