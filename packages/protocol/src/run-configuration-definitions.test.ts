import { describe, expect, it } from "vitest";

import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  RUN_CONFIGURATION_REPOSITORY_DIRECTORY,
  runConfigurationDartEntrypointSchema,
  runConfigurationDetectionCandidateSchema,
  runConfigurationFileSchema,
  runConfigurationFlutterEntrypointSchema,
  runConfigurationGradleProjectPathSchema,
  runConfigurationJavaClassNameSchema,
  runConfigurationMavenModuleSchema,
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

function javaConfiguration() {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1 as const,
    id: configurationId,
    name: "Run Java API",
    provider: "java" as const,
    workingDirectory: "services/api",
    target: {
      kind: "gradleMainClass" as const,
      projectPath: ":app",
      className: "com.example.ApiApplication",
    },
  };
}

function dartConfiguration() {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1 as const,
    id: configurationId,
    name: "Run Dart API",
    provider: "dart" as const,
    workingDirectory: "services/api",
    target: { kind: "entrypoint" as const, path: "bin/server.dart" },
  };
}

function flutterConfiguration() {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1 as const,
    id: configurationId,
    name: "Run Flutter app",
    provider: "flutter" as const,
    workingDirectory: "apps/mobile",
    target: { kind: "entrypoint" as const, path: "lib/main.dart" },
  };
}

function rustConfiguration() {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1 as const,
    id: configurationId,
    name: "Run Rust API",
    provider: "rust" as const,
    workingDirectory: ".",
    target: {
      kind: "binary" as const,
      package: "cantrip_server",
      name: "cantrip-server",
    },
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
    expect(runConfigurationFileSchema.parse(javaConfiguration())).toMatchObject(
      {
        provider: "java",
        target: {
          kind: "gradleMainClass",
          projectPath: ":app",
          className: "com.example.ApiApplication",
        },
        options: {
          jdkHome: null,
          useWrapper: true,
          buildToolArguments: [],
          vmArguments: [],
        },
        environment: { includeCodexEnvironment: true },
      },
    );
    expect(runConfigurationFileSchema.parse(dartConfiguration())).toMatchObject(
      {
        provider: "dart",
        target: { kind: "entrypoint", path: "bin/server.dart" },
        options: { sdkHome: null, vmArguments: [] },
        environment: { includeCodexEnvironment: true },
      },
    );
    expect(
      runConfigurationFileSchema.parse(flutterConfiguration()),
    ).toMatchObject({
      provider: "flutter",
      target: { kind: "entrypoint", path: "lib/main.dart" },
      options: {
        sdkHome: null,
        deviceId: null,
        flavor: null,
        mode: "debug",
        dartDefines: [],
        dartDefineFiles: [],
        usePub: true,
      },
      environment: { includeCodexEnvironment: true },
    });
    expect(runConfigurationFileSchema.parse(rustConfiguration())).toMatchObject(
      {
        provider: "rust",
        target: {
          kind: "binary",
          package: "cantrip_server",
          name: "cantrip-server",
        },
        options: {
          toolchain: "default",
          features: [],
          allFeatures: false,
          useDefaultFeatures: true,
          targetTriple: null,
          profile: "dev",
          locked: false,
          offline: false,
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

  it("keeps Java build targets typed, portable, and provider-correlated", () => {
    expect(runConfigurationJavaClassNameSchema.parse("demo.Main$Nested")).toBe(
      "demo.Main$Nested",
    );
    expect(runConfigurationGradleProjectPathSchema.parse(":apps:api")).toBe(
      ":apps:api",
    );
    expect(runConfigurationMavenModuleSchema.parse("services/api")).toBe(
      "services/api",
    );
    for (const target of [
      { kind: "gradleTask", projectPath: ":api", task: "bootRun" },
      {
        kind: "gradleMainClass",
        projectPath: ":api",
        className: "demo.Main",
      },
      { kind: "mavenGoal", module: "api", goal: "spring-boot:run" },
      {
        kind: "mavenMainClass",
        module: ":api",
        className: "demo.Main",
      },
    ]) {
      expect(
        runConfigurationFileSchema.safeParse({
          ...javaConfiguration(),
          target,
        }).success,
        JSON.stringify(target),
      ).toBe(true);
    }
    expect(
      runConfigurationFileSchema.safeParse({
        ...javaConfiguration(),
        target: {
          kind: "gradleMainClass",
          projectPath: "../api",
          className: "demo.Main",
        },
      }).success,
    ).toBe(false);
    expect(
      runConfigurationFileSchema.safeParse({
        ...javaConfiguration(),
        target: {
          kind: "mavenGoal",
          module: "-f",
          goal: "spring-boot:run",
        },
      }).success,
    ).toBe(false);
    const document = runConfigurationFileSchema.parse(javaConfiguration());
    expect(
      runConfigurationDetectionCandidateSchema.parse({
        provider: "java",
        confidence: "high",
        reason: "Gradle declares one application main class.",
        effectiveCommand:
          "./gradlew :app:_cantripRunConfigurationJava -PcantripMainClass=demo.Main",
        document,
      }).document.provider,
    ).toBe("java");
  });

  it("keeps Dart entrypoints portable, typed, and provider-correlated", () => {
    expect(runConfigurationDartEntrypointSchema.parse("tool/dev.dart")).toBe(
      "tool/dev.dart",
    );
    for (const path of ["../outside.dart", "bin/server.js", "/tmp/main.dart"]) {
      expect(
        runConfigurationFileSchema.safeParse({
          ...dartConfiguration(),
          target: { kind: "entrypoint", path },
        }).success,
        path,
      ).toBe(false);
    }
    expect(
      runConfigurationFileSchema.safeParse({
        ...dartConfiguration(),
        options: { sdkHome: null, vmArguments: [], unknown: true },
      }).success,
    ).toBe(false);
    const document = runConfigurationFileSchema.parse(dartConfiguration());
    expect(
      runConfigurationDetectionCandidateSchema.parse({
        provider: "dart",
        confidence: "high",
        reason: "The package has one Dart entrypoint.",
        effectiveCommand: "dart run bin/server.dart",
        document,
      }).document.provider,
    ).toBe("dart");
  });

  it("keeps Flutter targets and launch controls strict and provider-correlated", () => {
    expect(
      runConfigurationFlutterEntrypointSchema.parse("lib/main_staging.dart"),
    ).toBe("lib/main_staging.dart");
    for (const path of ["../outside.dart", "lib/main.js", "/tmp/main.dart"]) {
      expect(
        runConfigurationFileSchema.safeParse({
          ...flutterConfiguration(),
          target: { kind: "entrypoint", path },
        }).success,
        path,
      ).toBe(false);
    }
    expect(
      runConfigurationFileSchema.safeParse({
        ...flutterConfiguration(),
        options: {
          sdkHome: null,
          deviceId: "chrome",
          flavor: "staging",
          mode: "debug",
          dartDefines: [
            { name: "API_URL", value: "one" },
            { name: "API_URL", value: "two" },
          ],
          dartDefineFiles: ["config/staging.env"],
          usePub: true,
        },
      }).success,
    ).toBe(false);
    const document = runConfigurationFileSchema.parse({
      ...flutterConfiguration(),
      options: {
        deviceId: "chrome",
        flavor: "staging",
        mode: "profile",
        dartDefines: [{ name: "API_URL", value: "https://example.test" }],
        dartDefineFiles: ["config/staging.env"],
      },
    });
    expect(
      runConfigurationDetectionCandidateSchema.parse({
        provider: "flutter",
        confidence: "high",
        reason: "The Flutter package has a conventional entrypoint.",
        effectiveCommand:
          "flutter run --profile --target=lib/main.dart --device-id=chrome --flavor=staging",
        document,
      }).document.provider,
    ).toBe("flutter");
  });

  it("keeps Rust targets and Cargo controls strict and provider-correlated", () => {
    expect(
      runConfigurationFileSchema.safeParse({
        ...rustConfiguration(),
        target: {
          kind: "example",
          package: "demo-api",
          name: "quickstart",
        },
        options: {
          toolchain: "nightly-2026-08-01",
          features: ["tls", "workspace/tracing"],
          allFeatures: false,
          useDefaultFeatures: false,
          targetTriple: "aarch64-apple-darwin",
          profile: "release-lto",
          locked: true,
          offline: true,
        },
      }).success,
    ).toBe(true);
    for (const target of [
      { kind: "binary", package: "../api", name: "server" },
      { kind: "example", package: "api", name: "bad target" },
      { kind: "library", package: "api", name: "api" },
    ]) {
      expect(
        runConfigurationFileSchema.safeParse({
          ...rustConfiguration(),
          target,
        }).success,
        JSON.stringify(target),
      ).toBe(false);
    }
    expect(
      runConfigurationFileSchema.safeParse({
        ...rustConfiguration(),
        options: {
          toolchain: "+nightly",
          features: ["tls", "tls"],
          allFeatures: false,
          useDefaultFeatures: true,
          targetTriple: null,
          profile: "dev",
          locked: false,
          offline: false,
        },
      }).success,
    ).toBe(false);
    const document = runConfigurationFileSchema.parse(rustConfiguration());
    expect(
      runConfigurationDetectionCandidateSchema.parse({
        provider: "rust",
        confidence: "high",
        reason: "The Cargo package has one binary target.",
        effectiveCommand:
          "cargo run --package=cantrip_server --bin=cantrip-server",
        document,
      }).document.provider,
    ).toBe("rust");
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
