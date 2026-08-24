import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunConfigurationShellDocument } from "@cantrip/protocol/run-configuration-definitions";
import type { RunConfigurationProtectedSecret } from "@cantrip/protocol/run-configuration-secrets";
import type {
  RunConfigurationRuntimeLaunchIdentity,
  RunConfigurationRuntimeWorkerObservation,
} from "@cantrip/protocol/run-configuration-runtime";
import { afterEach, describe, expect, it } from "vitest";

import {
  RunConfigurationRuntimeSupervisor,
  type RunConfigurationRuntimeSupervisorOptions,
} from "./run-configuration-runtime-supervisor.js";
import {
  inspectRunConfigurationCodexEnvironmentSource,
  resolveRunConfigurationEnvironmentSources,
} from "./run-configuration-environment-source.js";
import { RunConfigurationRepository } from "./run-configuration-repository.js";

const temporaryDirectories: string[] = [];

interface Fixture {
  configurationId: string;
  definitionRevision: string;
  sourceRoot: string;
  targetRoot: string;
}

async function nodeFixture(): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-node-run-configuration-runtime-"),
  );
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "primary");
  const targetRoot = path.join(root, "target");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(targetRoot, { recursive: true }),
  ]);
  await writeFile(
    path.join(targetRoot, "app.js"),
    'process.stdout.write("node-provider|" + process.argv.slice(2).join("|"));\n',
  );
  const configurationId = randomUUID();
  const repository = await RunConfigurationRepository.open(sourceRoot);
  const written = await repository.write({
    expectedRevision: null,
    document: {
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Node runtime fixture",
      provider: "node",
      workingDirectory: ".",
      target: { kind: "entry", path: "app.js" },
      commandOverride: null,
      arguments: ["--flag", "two words"],
      environment: {
        includeCodexEnvironment: false,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: [],
      platformOverrides: {},
      options: {
        packageManager: "npm",
        runtime: "node",
        runtimeArguments: [],
      },
      stop: { gracePeriodMs: 50 },
    },
  });
  if (!("entry" in written) || !written.entry.revision) {
    throw new Error("Expected a ready Node Run configuration fixture.");
  }
  return {
    configurationId,
    definitionRevision: written.entry.revision,
    sourceRoot,
    targetRoot,
  };
}

async function javaFixture(): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-java-run-configuration-runtime-"),
  );
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "primary");
  const targetRoot = path.join(root, "target");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(targetRoot, { recursive: true }),
  ]);
  await writeFile(
    path.join(targetRoot, "pom.xml"),
    "<project><artifactId>api</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>",
  );
  await writeFile(
    path.join(targetRoot, "mvnw"),
    "#!/bin/sh\nprintf 'java-provider|%s' \"$*\"\n",
  );
  await chmod(path.join(targetRoot, "mvnw"), 0o755);
  const configurationId = randomUUID();
  const repository = await RunConfigurationRepository.open(sourceRoot);
  const written = await repository.write({
    expectedRevision: null,
    document: {
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Java runtime fixture",
      provider: "java",
      workingDirectory: ".",
      target: {
        kind: "mavenGoal",
        module: null,
        goal: "spring-boot:run",
      },
      commandOverride: null,
      arguments: ["--server.port=4400", "two words"],
      environment: {
        includeCodexEnvironment: false,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: [],
      platformOverrides: {},
      options: {
        jdkHome: null,
        useWrapper: true,
        buildToolArguments: ["--no-transfer-progress"],
        vmArguments: [],
      },
      stop: { gracePeriodMs: 50 },
    },
  });
  if (!("entry" in written) || !written.entry.revision) {
    throw new Error("Expected a ready Java Run configuration fixture.");
  }
  return {
    configurationId,
    definitionRevision: written.entry.revision,
    sourceRoot,
    targetRoot,
  };
}

async function dartFixture(): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-dart-run-configuration-runtime-"),
  );
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "primary");
  const targetRoot = path.join(root, "target");
  const sdkHome = path.join(root, "dart-sdk");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(path.join(targetRoot, "bin"), { recursive: true }),
    mkdir(path.join(sdkHome, "bin"), { recursive: true }),
  ]);
  await writeFile(path.join(targetRoot, "pubspec.yaml"), "name: api\n");
  await writeFile(
    path.join(targetRoot, "bin", "server.dart"),
    "void main(List<String> arguments) {}\n",
  );
  await writeFile(
    path.join(sdkHome, "bin", "dart"),
    "#!/bin/sh\nprintf 'dart-provider|%s' \"$*\"\n",
  );
  await chmod(path.join(sdkHome, "bin", "dart"), 0o755);
  const configurationId = randomUUID();
  const repository = await RunConfigurationRepository.open(sourceRoot);
  const written = await repository.write({
    expectedRevision: null,
    document: {
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Dart runtime fixture",
      provider: "dart",
      workingDirectory: ".",
      target: { kind: "entrypoint", path: "bin/server.dart" },
      commandOverride: null,
      arguments: ["--port", "4400"],
      environment: {
        includeCodexEnvironment: false,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: [],
      platformOverrides: {},
      options: { sdkHome, vmArguments: ["--enable-asserts"] },
      stop: { gracePeriodMs: 50 },
    },
  });
  if (!("entry" in written) || !written.entry.revision) {
    throw new Error("Expected a ready Dart Run configuration fixture.");
  }
  return {
    configurationId,
    definitionRevision: written.entry.revision,
    sourceRoot,
    targetRoot,
  };
}

async function flutterFixture(): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-flutter-run-configuration-runtime-"),
  );
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "primary");
  const targetRoot = path.join(root, "target");
  const sdkHome = path.join(root, "flutter-sdk");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(path.join(targetRoot, "lib"), { recursive: true }),
    mkdir(path.join(sdkHome, "bin"), { recursive: true }),
  ]);
  await writeFile(
    path.join(targetRoot, "pubspec.yaml"),
    "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n",
  );
  await writeFile(
    path.join(targetRoot, "lib", "main.dart"),
    "void main(List<String> arguments) {}\n",
  );
  await writeFile(
    path.join(sdkHome, "bin", "flutter"),
    "#!/bin/sh\nprintf 'flutter-provider|%s' \"$*\"\n",
  );
  await chmod(path.join(sdkHome, "bin", "flutter"), 0o755);
  const configurationId = randomUUID();
  const repository = await RunConfigurationRepository.open(sourceRoot);
  const written = await repository.write({
    expectedRevision: null,
    document: {
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Flutter runtime fixture",
      provider: "flutter",
      workingDirectory: ".",
      target: { kind: "entrypoint", path: "lib/main.dart" },
      commandOverride: null,
      arguments: ["two words"],
      environment: {
        includeCodexEnvironment: false,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: [],
      platformOverrides: {},
      options: {
        sdkHome,
        deviceId: "linux",
        flavor: "staging",
        mode: "profile",
        dartDefines: [{ name: "API_URL", value: "https://example.test" }],
        dartDefineFiles: [],
        usePub: false,
      },
      stop: { gracePeriodMs: 50 },
    },
  });
  if (!("entry" in written) || !written.entry.revision) {
    throw new Error("Expected a ready Flutter Run configuration fixture.");
  }
  return {
    configurationId,
    definitionRevision: written.entry.revision,
    sourceRoot,
    targetRoot,
  };
}

async function rustFixture(
  toolchain = "default",
): Promise<Fixture & { executableDirectory: string }> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-rust-run-configuration-runtime-"),
  );
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "primary");
  const targetRoot = path.join(root, "target");
  const executableDirectory = path.join(root, "bin");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(path.join(targetRoot, "src"), { recursive: true }),
    mkdir(executableDirectory, { recursive: true }),
  ]);
  await writeFile(
    path.join(targetRoot, "Cargo.toml"),
    '[package]\nname = "api"\nversion = "0.1.0"\n\n[[bin]]\nname = "server"\npath = "src/server.rs"\n',
  );
  await writeFile(path.join(targetRoot, "src", "server.rs"), "fn main() {}\n");
  await writeFile(
    path.join(executableDirectory, "cargo"),
    "#!/bin/sh\nprintf 'rust-provider|%s' \"$*\"\n",
  );
  await chmod(path.join(executableDirectory, "cargo"), 0o755);
  const configurationId = randomUUID();
  const repository = await RunConfigurationRepository.open(sourceRoot);
  const written = await repository.write({
    expectedRevision: null,
    document: {
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Rust runtime fixture",
      provider: "rust",
      workingDirectory: ".",
      target: { kind: "binary", package: "api", name: "server" },
      commandOverride: null,
      arguments: ["--listen", "two words"],
      environment: {
        includeCodexEnvironment: false,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: [],
      platformOverrides: {},
      options: {
        toolchain,
        features: ["tls"],
        allFeatures: false,
        useDefaultFeatures: false,
        targetTriple: null,
        profile: "release",
        locked: true,
        offline: false,
      },
      stop: { gracePeriodMs: 50 },
    },
  });
  if (!("entry" in written) || !written.entry.revision) {
    throw new Error("Expected a ready Rust Run configuration fixture.");
  }
  return {
    configurationId,
    definitionRevision: written.entry.revision,
    executableDirectory,
    sourceRoot,
    targetRoot,
  };
}

async function fixture(
  command: string,
  options: {
    beforeLaunch?: RunConfigurationShellDocument["beforeLaunch"];
    environment?: RunConfigurationShellDocument["environment"];
    targetRoot?: string;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-run-configuration-runtime-"),
  );
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "primary");
  const targetRoot = options.targetRoot ?? path.join(root, "target");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(targetRoot, { recursive: true }),
  ]);
  const configurationId = randomUUID();
  const repository = await RunConfigurationRepository.open(sourceRoot);
  const written = await repository.write({
    expectedRevision: null,
    document: {
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Runtime fixture",
      provider: "shell",
      workingDirectory: ".",
      target: { kind: "command", command },
      commandOverride: null,
      arguments: [],
      environment: options.environment ?? {
        includeCodexEnvironment: false,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: options.beforeLaunch ?? [],
      platformOverrides: {},
      options: { shell: "automatic", login: true },
      stop: { gracePeriodMs: 50 },
    },
  });
  if (!("entry" in written) || !written.entry.revision) {
    throw new Error("Expected a ready Run configuration fixture.");
  }
  return {
    configurationId,
    definitionRevision: written.entry.revision,
    sourceRoot,
    targetRoot,
  };
}

function identity(
  input: Fixture,
  generation = 1,
  overrides: Partial<RunConfigurationRuntimeLaunchIdentity> = {},
): RunConfigurationRuntimeLaunchIdentity {
  return {
    runtimeId: randomUUID(),
    projectId: randomUUID(),
    configurationId: input.configurationId,
    worktreeId: randomUUID(),
    workerId: "runtime-worker",
    definitionRevision: input.definitionRevision,
    codexEnvironmentRevision: null,
    generation,
    operationId: randomUUID(),
    terminalId: randomUUID(),
    ...overrides,
  };
}

function startCommand(
  input: Fixture,
  runtimeIdentity: RunConfigurationRuntimeLaunchIdentity,
  protectedSecrets: RunConfigurationProtectedSecret[] = [],
) {
  return {
    type: "project.run-configuration-runtime.start" as const,
    identity: runtimeIdentity,
    rootKind: "git-root" as const,
    sourcePath: input.sourceRoot,
    targetPath: input.targetRoot,
    protectedSecrets,
  };
}

function restartCommand(
  input: Fixture,
  runtimeIdentity: RunConfigurationRuntimeLaunchIdentity,
  protectedSecrets: RunConfigurationProtectedSecret[] = [],
) {
  return {
    ...startCommand(input, runtimeIdentity, protectedSecrets),
    type: "project.run-configuration-runtime.restart" as const,
  };
}

function protectedSecret(
  reference: string,
  revision: number,
): RunConfigurationProtectedSecret {
  return {
    reference,
    revision,
    protectedValue: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}

function supervisor(
  notifications: RunConfigurationRuntimeWorkerObservation[] = [],
  options: Partial<RunConfigurationRuntimeSupervisorOptions> = {},
): RunConfigurationRuntimeSupervisor {
  return new RunConfigurationRuntimeSupervisor({
    platform: "linux",
    environment: process.env,
    authorize: async (command) => ({
      sourceRoot: command.sourcePath,
      targetRoot: command.targetPath,
    }),
    notify: (observation) => notifications.push(observation),
    ...options,
  });
}

function resolveLiveEnvironment(
  resolution: Parameters<
    NonNullable<RunConfigurationRuntimeSupervisorOptions["resolveEnvironment"]>
  >[0],
) {
  return resolveRunConfigurationEnvironmentSources({
    baseline: resolution.baseline,
    defaultShell: resolution.defaultShell,
    environment: resolution.environment,
    expectedCodexEnvironmentRevision:
      resolution.identity.codexEnvironmentRevision,
    execute: resolution.execute,
    platform: resolution.platform,
    protectedSecrets: resolution.protectedSecrets,
    sourceRoot: resolution.sourceRoot,
    targetRoot: resolution.targetRoot,
    openSecret: async (secret) => `opened-secret-revision-${secret.revision}`,
  });
}

async function waitForState(
  runs: RunConfigurationRuntimeSupervisor,
  runtimeIdentity: RunConfigurationRuntimeLaunchIdentity,
  state: RunConfigurationRuntimeWorkerObservation["state"],
  timeout = 5_000,
): Promise<RunConfigurationRuntimeWorkerObservation> {
  await expect
    .poll(
      () => {
        const lookup = runs.status(runtimeIdentity);
        return lookup.found ? lookup.observation.state : "missing";
      },
      { timeout },
    )
    .toBe(state);
  const lookup = runs.status(runtimeIdentity);
  if (!lookup.found) throw new Error("Expected the runtime to be available.");
  return lookup.observation;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "RunConfigurationRuntimeSupervisor",
  () => {
    it("rereads the Primary definition and launches a bounded worker-owned PTY", async () => {
      const input = await fixture(
        `printf '%s|%s|%s|%s|%s|%s' "$CANTRIP_PROJECT_ROOT" "$CANTRIP_WORKTREE_PATH" "$CANTRIP_RUN_CONFIGURATION_ID" "$CANTRIP_RUN_GENERATION" "$PLAIN_FIXTURE" "$LAYERED_FIXTURE"`,
        {
          beforeLaunch: [
            {
              kind: "command",
              command: "printf 'before-launch\\n'",
              workingDirectory: ".",
            },
          ],
          environment: {
            includeCodexEnvironment: true,
            files: [],
            variables: [
              { name: "PLAIN_FIXTURE", value: "plain", enabled: true },
              {
                name: "LAYERED_FIXTURE",
                value: "plain-must-not-win",
                enabled: true,
              },
              {
                name: "CANTRIP_PROJECT_ROOT",
                value: "reserved-must-not-win",
                enabled: true,
              },
            ],
            secrets: [],
          },
        },
      );
      const runtimeIdentity = identity(input);
      const notifications: RunConfigurationRuntimeWorkerObservation[] = [];
      const runs = supervisor(notifications, {
        resolveEnvironment: async () => ({
          codex: { LAYERED_FIXTURE: "codex" },
          files: { LAYERED_FIXTURE: "file" },
          secrets: { LAYERED_FIXTURE: "secret" },
          codexEnvironmentRevision: null,
        }),
      });

      expect(
        await runs.start(startCommand(input, runtimeIdentity)),
      ).toMatchObject({
        outcome: "accepted",
        observation: { state: "starting", generation: 1 },
      });
      expect(runs.ownsTerminal(runtimeIdentity.terminalId)).toBe(true);
      expect(runs.ownsTerminal(randomUUID())).toBe(false);
      await waitForState(runs, runtimeIdentity, "exited");
      const output = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: runtimeIdentity,
        tail: 100_000,
      });
      expect(output.data).toContain("before-launch");
      expect(output.data).toContain(
        `${input.sourceRoot}|${input.targetRoot}|${input.configurationId}|1|plain|secret`,
      );
      expect(JSON.stringify(notifications)).not.toContain(
        "reserved-must-not-win",
      );
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 8,
        }),
      ).toMatchObject({ truncated: true });
      await runs.closeAll();
    });

    it("re-resolves live Codex setup and ordered environment files for every generation", async () => {
      const input = await fixture(
        `printf '%s|%s|%s|%s' "$CODEX_VALUE" "$LAYERED_VALUE" "$FILE_ONLY" "$CANTRIP_WORKER_CREDENTIAL"`,
        {
          environment: {
            includeCodexEnvironment: true,
            files: [".env", ".env.local"],
            variables: [
              { name: "LAYERED_VALUE", value: "plain", enabled: true },
              {
                name: "CANTRIP_WORKER_CREDENTIAL",
                value: "definition-must-not-win",
                enabled: true,
              },
            ],
            secrets: [],
          },
        },
      );
      await mkdir(path.join(input.sourceRoot, ".codex", "environments"), {
        recursive: true,
      });
      const environmentPath = path.join(
        input.sourceRoot,
        ".codex",
        "environments",
        "environment.toml",
      );
      await writeFile(
        environmentPath,
        `[setup]
script = "printf 'materializing-first\\n'; export CODEX_VALUE=first; export LAYERED_VALUE=codex"
`,
      );
      await writeFile(
        path.join(input.targetRoot, ".env"),
        "LAYERED_VALUE=file-first\nFILE_ONLY=first\n",
      );
      await writeFile(
        path.join(input.targetRoot, ".env.local"),
        "LAYERED_VALUE=file-second\n",
      );
      const firstSource = await inspectRunConfigurationCodexEnvironmentSource({
        enabled: true,
        platform: "linux",
        sourceRoot: input.sourceRoot,
      });
      const runs = supervisor([], {
        environment: {
          ...process.env,
          CANTRIP_WORKER_CREDENTIAL: "protected-baseline",
        },
        resolveEnvironment: resolveLiveEnvironment,
      });
      const firstIdentity = identity(input, 1, {
        codexEnvironmentRevision: firstSource.revision,
      });
      await runs.start(startCommand(input, firstIdentity));
      await waitForState(runs, firstIdentity, "exited");
      const firstOutput = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: firstIdentity,
        tail: 100_000,
      }).data;
      expect(firstOutput).toContain("materializing-first");
      expect(firstOutput).toContain("first|plain|first|protected-baseline");

      await writeFile(
        environmentPath,
        `[setup]
script = "printf 'materializing-second\\n'; export CODEX_VALUE=second; export LAYERED_VALUE=codex"
`,
      );
      const secondSource = await inspectRunConfigurationCodexEnvironmentSource({
        enabled: true,
        platform: "linux",
        sourceRoot: input.sourceRoot,
      });
      expect(secondSource.revision).not.toBe(firstSource.revision);
      const secondIdentity = {
        ...firstIdentity,
        codexEnvironmentRevision: secondSource.revision,
        generation: 2,
        operationId: randomUUID(),
      };
      await runs.start(startCommand(input, secondIdentity));
      await waitForState(runs, secondIdentity, "exited");
      const secondOutput = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: secondIdentity,
        tail: 100_000,
      }).data;
      expect(secondOutput).toContain("materializing-second");
      expect(secondOutput).toContain("second|plain|first|protected-baseline");
      expect(secondOutput).toContain(
        "[Starting next generation · generation 2]",
      );
      await runs.closeAll();
    });

    it("uses the current project-secret revision on each generation without exposing it in observations", async () => {
      const input = await fixture(
        `printf '%s|%s' "$TOKEN" "$CANTRIP_WORKER_CREDENTIAL" > secret-result.txt`,
        {
          environment: {
            includeCodexEnvironment: false,
            files: [],
            variables: [],
            secrets: [
              { name: "TOKEN", secret: "project/token", enabled: true },
              {
                name: "CANTRIP_WORKER_CREDENTIAL",
                secret: "project/token",
                enabled: true,
              },
            ],
          },
        },
      );
      const notifications: RunConfigurationRuntimeWorkerObservation[] = [];
      const runs = supervisor(notifications, {
        environment: {
          ...process.env,
          CANTRIP_WORKER_CREDENTIAL: "protected-baseline",
        },
        resolveEnvironment: resolveLiveEnvironment,
      });
      const first = identity(input);
      await runs.start(
        startCommand(input, first, [protectedSecret("project/token", 1)]),
      );
      await waitForState(runs, first, "exited");
      await expect(
        readFile(path.join(input.targetRoot, "secret-result.txt"), "utf8"),
      ).resolves.toBe("opened-secret-revision-1|protected-baseline");

      const second = {
        ...first,
        generation: 2,
        operationId: randomUUID(),
      };
      await runs.start(
        startCommand(input, second, [protectedSecret("project/token", 2)]),
      );
      await waitForState(runs, second, "exited");
      await expect(
        readFile(path.join(input.targetRoot, "secret-result.txt"), "utf8"),
      ).resolves.toBe("opened-secret-revision-2|protected-baseline");
      expect(JSON.stringify(notifications)).not.toContain(
        "opened-secret-revision",
      );
      await runs.closeAll();
    });

    it("tracks Codex setup as a stoppable pre-launch process", async () => {
      const input = await fixture("printf launched > launched.txt", {
        environment: {
          includeCodexEnvironment: true,
          files: [],
          variables: [],
          secrets: [],
        },
      });
      await mkdir(path.join(input.sourceRoot, ".codex", "environments"), {
        recursive: true,
      });
      await writeFile(
        path.join(
          input.sourceRoot,
          ".codex",
          "environments",
          "environment.toml",
        ),
        `[setup]
script = "printf 'setup-started\\n'; while :; do sleep 1; done"
`,
      );
      const source = await inspectRunConfigurationCodexEnvironmentSource({
        enabled: true,
        platform: "linux",
        sourceRoot: input.sourceRoot,
      });
      const runtimeIdentity = identity(input, 1, {
        codexEnvironmentRevision: source.revision,
      });
      const runs = supervisor([], {
        resolveEnvironment: resolveLiveEnvironment,
      });
      await runs.start(startCommand(input, runtimeIdentity));
      await expect
        .poll(
          () =>
            runs.output({
              type: "project.run-configuration-runtime.output",
              requestOperationId: randomUUID(),
              identity: runtimeIdentity,
              tail: 100_000,
            }).data,
          { timeout: 3_000 },
        )
        .toContain("setup-started");
      const stopIdentity = { ...runtimeIdentity, operationId: randomUUID() };
      await expect(
        runs.stop({
          type: "project.run-configuration-runtime.stop",
          identity: stopIdentity,
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        observation: { state: "idle" },
      });
      await expect(
        readFile(path.join(input.targetRoot, "launched.txt")),
      ).rejects.toThrow();
      await runs.closeAll();
    });

    it("launches a structured Node entrypoint without a handwritten command", async () => {
      const input = await nodeFixture();
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      await expect(
        runs.start(startCommand(input, runtimeIdentity)),
      ).resolves.toMatchObject({
        outcome: "accepted",
        observation: { state: "starting" },
      });
      await waitForState(runs, runtimeIdentity, "exited");
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 100_000,
        }).data,
      ).toContain("node-provider|--flag|two words");
      await runs.closeAll();
    });

    it("launches a structured Java build target without a handwritten command", async () => {
      const input = await javaFixture();
      const fixtureRoot = path.dirname(input.sourceRoot);
      const emptyPath = path.join(fixtureRoot, "empty-java-path");
      const jdkHome = path.join(fixtureRoot, "resolved-jdk");
      await Promise.all([
        mkdir(emptyPath),
        mkdir(path.join(jdkHome, "bin"), { recursive: true }),
      ]);
      await writeFile(path.join(jdkHome, "bin", "java"), "#!/bin/sh\nexit 0\n");
      await chmod(path.join(jdkHome, "bin", "java"), 0o755);
      const runtimeIdentity = identity(input);
      const runs = supervisor([], {
        environment: { PATH: emptyPath, JAVA_HOME: "" },
        resolveEnvironment: async () => ({ files: { JAVA_HOME: jdkHome } }),
      });
      await expect(
        runs.start(startCommand(input, runtimeIdentity)),
      ).resolves.toMatchObject({
        outcome: "accepted",
        observation: { state: "starting" },
      });
      await waitForState(runs, runtimeIdentity, "exited");
      const output = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: runtimeIdentity,
        tail: 100_000,
      }).data;
      expect(output).toContain("java-provider|--no-transfer-progress");
      expect(output).toContain("spring-boot:run");
      expect(output).toContain("--server.port=4400");
      await runs.closeAll();
    });

    it("fails Java provider validation before spawning a build wrapper when no runtime is available", async () => {
      const input = await javaFixture();
      const emptyPath = path.join(path.dirname(input.sourceRoot), "empty-bin");
      await mkdir(emptyPath);
      const runtimeIdentity = identity(input);
      const runs = supervisor([], {
        environment: { PATH: emptyPath, JAVA_HOME: "" },
      });

      await runs.start(startCommand(input, runtimeIdentity));
      const failed = await waitForState(runs, runtimeIdentity, "failed");
      expect(failed.failure).toMatchObject({
        phase: "provider",
        code: "executable-unavailable",
        message: expect.stringContaining("java"),
      });
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 100_000,
        }).data,
      ).not.toContain("java-provider");
      await runs.closeAll();
    });

    it("launches a structured Dart entrypoint without a handwritten command", async () => {
      const input = await dartFixture();
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      await expect(
        runs.start(startCommand(input, runtimeIdentity)),
      ).resolves.toMatchObject({
        outcome: "accepted",
        observation: { state: "starting" },
      });
      await waitForState(runs, runtimeIdentity, "exited");
      const output = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: runtimeIdentity,
        tail: 100_000,
      }).data;
      expect(output).toContain(
        "dart-provider|run --enable-asserts bin/server.dart --port 4400",
      );
      await runs.closeAll();
    });

    it("launches a structured Flutter target without a handwritten command", async () => {
      const input = await flutterFixture();
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      await expect(
        runs.start(startCommand(input, runtimeIdentity)),
      ).resolves.toMatchObject({
        outcome: "accepted",
        observation: { state: "starting" },
      });
      await waitForState(runs, runtimeIdentity, "exited");
      const output = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: runtimeIdentity,
        tail: 100_000,
      }).data;
      expect(output).toContain(
        "flutter-provider|run --profile --target=lib/main.dart --device-id=linux --flavor=staging --dart-define=API_URL=https://example.test --no-pub --dart-entrypoint-args=two words",
      );
      await runs.closeAll();
    });

    it("launches a structured Rust target without a handwritten command", async () => {
      const input = await rustFixture();
      const runtimeIdentity = identity(input);
      const runs = supervisor([], {
        environment: {
          ...process.env,
          PATH: `${input.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });
      await expect(
        runs.start(startCommand(input, runtimeIdentity)),
      ).resolves.toMatchObject({
        outcome: "accepted",
        observation: { state: "starting" },
      });
      await waitForState(runs, runtimeIdentity, "exited");
      const output = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: runtimeIdentity,
        tail: 100_000,
      }).data;
      expect(output).toContain(
        "rust-provider|run --package=api --bin=server --features=tls --no-default-features --release --locked -- --listen two words",
      );
      await runs.closeAll();
    });

    it("fails provider validation before spawn when a required tool is absent", async () => {
      const input = await rustFixture();
      const emptyPath = path.join(path.dirname(input.sourceRoot), "empty-bin");
      await mkdir(emptyPath);
      const runtimeIdentity = identity(input);
      const runs = supervisor([], {
        environment: { PATH: emptyPath },
      });

      await runs.start(startCommand(input, runtimeIdentity));
      const failed = await waitForState(runs, runtimeIdentity, "failed");
      expect(failed.failure).toMatchObject({
        phase: "provider",
        code: "executable-unavailable",
        message: expect.stringContaining("cargo"),
      });
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 100_000,
        }).data,
      ).not.toContain("rust-provider");
      await runs.closeAll();
    });

    it("fails before spawn when an explicit Rust toolchain is absent", async () => {
      const input = await rustFixture("nightly-2026-08-01");
      const emptyRustupHome = path.join(
        path.dirname(input.sourceRoot),
        "empty-rustup",
      );
      await mkdir(emptyRustupHome);
      const runtimeIdentity = identity(input);
      const runs = supervisor([], {
        environment: {
          PATH: input.executableDirectory,
          RUSTUP_HOME: emptyRustupHome,
        },
      });

      await runs.start(startCommand(input, runtimeIdentity));
      const failed = await waitForState(runs, runtimeIdentity, "failed");
      expect(failed.failure).toMatchObject({
        phase: "provider",
        code: "rust-toolchain-unavailable",
        message: expect.stringContaining("nightly-2026-08-01"),
      });
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 100_000,
        }).data,
      ).not.toContain("rust-provider");
      await runs.closeAll();
    });

    it("preflights required tools against the fully resolved live environment", async () => {
      const input = await rustFixture("nightly-2026-08-01");
      const emptyPath = path.join(path.dirname(input.sourceRoot), "empty-bin");
      const emptyRustupHome = path.join(
        path.dirname(input.sourceRoot),
        "empty-rustup",
      );
      const rustupHome = path.join(
        path.dirname(input.sourceRoot),
        "resolved-rustup",
      );
      const toolchainBin = path.join(
        rustupHome,
        "toolchains",
        "nightly-2026-08-01-x86_64-unknown-linux-gnu",
        "bin",
      );
      await Promise.all([
        mkdir(emptyPath),
        mkdir(emptyRustupHome),
        mkdir(toolchainBin, { recursive: true }),
      ]);
      const toolchainCargo = path.join(toolchainBin, "cargo");
      await writeFile(toolchainCargo, "#!/bin/sh\nexit 0\n");
      await chmod(toolchainCargo, 0o755);
      const runtimeIdentity = identity(input);
      const runs = supervisor([], {
        environment: { PATH: emptyPath, RUSTUP_HOME: emptyRustupHome },
        resolveEnvironment: async () => ({
          files: {
            PATH: input.executableDirectory,
            RUSTUP_HOME: rustupHome,
          },
        }),
      });

      await runs.start(startCommand(input, runtimeIdentity));
      await waitForState(runs, runtimeIdentity, "exited");
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 100_000,
        }).data,
      ).toContain("rust-provider|+nightly-2026-08-01 run");
      await runs.closeAll();
    });

    it("replays one generation and fails closed when its revision is stale", async () => {
      const input = await fixture("printf started >> launch-count.txt");
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      const command = startCommand(input, runtimeIdentity);
      await runs.start(command);
      expect(await runs.start(command)).toMatchObject({ outcome: "replayed" });
      await waitForState(runs, runtimeIdentity, "exited");
      expect(
        await readFile(path.join(input.targetRoot, "launch-count.txt"), "utf8"),
      ).toBe("started");

      const nextGeneration = {
        ...runtimeIdentity,
        generation: 2,
        operationId: randomUUID(),
      };
      expect(
        await runs.start(startCommand(input, nextGeneration)),
      ).toMatchObject({
        outcome: "accepted",
        observation: {
          generation: 2,
          terminalId: runtimeIdentity.terminalId,
        },
      });
      await waitForState(runs, nextGeneration, "exited");
      expect(
        await readFile(path.join(input.targetRoot, "launch-count.txt"), "utf8"),
      ).toBe("startedstarted");
      expect(await runs.start(command)).toMatchObject({ outcome: "stale" });

      const recoveredGeneration = {
        ...nextGeneration,
        generation: 7,
        operationId: randomUUID(),
      };
      expect(
        await runs.start(startCommand(input, recoveredGeneration)),
      ).toMatchObject({
        outcome: "accepted",
        observation: { generation: 7 },
      });
      await waitForState(runs, recoveredGeneration, "exited");

      const coldWorker = supervisor();
      const durableGeneration = identity(input, 11);
      expect(
        await coldWorker.start(startCommand(input, durableGeneration)),
      ).toMatchObject({
        outcome: "accepted",
        observation: { generation: 11 },
      });
      await waitForState(coldWorker, durableGeneration, "exited");
      await coldWorker.closeAll();

      const staleIdentity = identity(input, 1, {
        definitionRevision: "f".repeat(64),
      });
      await runs.start(startCommand(input, staleIdentity));
      const failed = await waitForState(runs, staleIdentity, "failed");
      expect(failed.failure).toMatchObject({
        phase: "definition",
        code: "definition-revision-mismatch",
      });
      await runs.closeAll();
    });

    it("fails a generation before spawn when an ordered pre-launch step fails", async () => {
      const input = await fixture("printf forbidden > main-started.txt", {
        beforeLaunch: [
          {
            kind: "command",
            command: "printf 'preflight failed\\n'; exit 7",
            workingDirectory: ".",
          },
        ],
      });
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      await runs.start(startCommand(input, runtimeIdentity));
      const failed = await waitForState(runs, runtimeIdentity, "failed");
      expect(failed.failure).toMatchObject({
        phase: "before-launch",
        code: "before-launch-failed",
      });
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 100_000,
        }).data,
      ).toContain("preflight failed");
      await expect(
        readFile(path.join(input.targetRoot, "main-started.txt")),
      ).rejects.toThrow();
      await runs.closeAll();
    });

    it("redacts unexpected worker-local launch errors from observations", async () => {
      const input = await fixture("printf should-not-start");
      const runtimeIdentity = identity(input);
      const notifications: RunConfigurationRuntimeWorkerObservation[] = [];
      const runs = supervisor(notifications, {
        authorize: async () => {
          throw new Error("sensitive-local-path /private/project/token");
        },
      });
      await runs.start(startCommand(input, runtimeIdentity));
      const failed = await waitForState(runs, runtimeIdentity, "failed");
      expect(failed.failure).toMatchObject({
        phase: "spawn",
        code: "launch-failed",
        message: "The Run could not start.",
      });
      expect(JSON.stringify(notifications)).not.toContain(
        "sensitive-local-path",
      );
      await runs.closeAll();
    });

    it("restarts immediately in the same terminal and fences the stale exit", async () => {
      const input = await fixture(
        `printf 'generation:%s\\n' "$CANTRIP_RUN_GENERATION"
if [ "$CANTRIP_RUN_GENERATION" = 1 ]; then
  (sleep 0.4; printf old > old-orphan.txt) &
else
  (sleep 1; printf stopped > stop-orphan.txt) &
fi
while :; do sleep 1; done`,
      );
      const first = identity(input);
      const runs = supervisor();
      await runs.start(startCommand(input, first));
      await waitForState(runs, first, "running");
      await expect
        .poll(
          () =>
            runs.output({
              type: "project.run-configuration-runtime.output",
              requestOperationId: randomUUID(),
              identity: first,
              tail: 100_000,
            }).data,
          { timeout: 2_000 },
        )
        .toContain("generation:1");

      const second = {
        ...first,
        generation: 2,
        operationId: randomUUID(),
      };
      expect(await runs.restart(restartCommand(input, second))).toMatchObject({
        outcome: "accepted",
        observation: { generation: 2 },
      });
      await waitForState(runs, second, "running");
      const restartedOutput = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: second,
        tail: 100_000,
      }).data;
      expect(restartedOutput).toContain("generation:1");
      expect(restartedOutput).toContain("[Restarting · generation 2]");
      await expect
        .poll(
          () =>
            runs.output({
              type: "project.run-configuration-runtime.output",
              requestOperationId: randomUUID(),
              identity: second,
              tail: 100_000,
            }).data,
          { timeout: 2_000 },
        )
        .toContain("generation:2");
      expect(second.terminalId).toBe(first.terminalId);
      expect(runs.status(first)).toMatchObject({ found: false });

      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(
        readFile(path.join(input.targetRoot, "old-orphan.txt")),
      ).rejects.toThrow();
      expect(runs.status(second)).toMatchObject({
        found: true,
        observation: { state: "running", generation: 2 },
      });

      const stopIdentity = { ...second, operationId: randomUUID() };
      expect(
        await runs.stop({
          type: "project.run-configuration-runtime.stop",
          identity: stopIdentity,
        }),
      ).toMatchObject({
        outcome: "accepted",
        observation: { state: "idle", terminalId: first.terminalId },
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect(
        readFile(path.join(input.targetRoot, "stop-orphan.txt")),
      ).rejects.toThrow();
      await runs.closeAll();
    });

    it("runs the same configuration independently in parallel worktrees", async () => {
      const input = await fixture(
        `printf '%s' "$CANTRIP_RUN_WORKTREE_ID"; while :; do sleep 1; done`,
      );
      const alternateRoot = path.join(
        path.dirname(input.targetRoot),
        "alternate-target",
      );
      await mkdir(alternateRoot, { recursive: true });
      const alternate = { ...input, targetRoot: alternateRoot };
      const primaryIdentity = identity(input);
      const alternateIdentity = identity(alternate, 1, {
        projectId: primaryIdentity.projectId,
        configurationId: primaryIdentity.configurationId,
      });
      const runs = supervisor();

      await Promise.all([
        runs.start(startCommand(input, primaryIdentity)),
        runs.start(startCommand(alternate, alternateIdentity)),
      ]);
      await Promise.all([
        waitForState(runs, primaryIdentity, "running"),
        waitForState(runs, alternateIdentity, "running"),
      ]);
      await Promise.all(
        [primaryIdentity, alternateIdentity].map((runtimeIdentity) =>
          expect
            .poll(
              () =>
                runs.output({
                  type: "project.run-configuration-runtime.output",
                  requestOperationId: randomUUID(),
                  identity: runtimeIdentity,
                  tail: 100_000,
                }).data,
            )
            .toContain(runtimeIdentity.worktreeId),
        ),
      );

      const reconciliation = await runs.reconcile([primaryIdentity]);
      expect(reconciliation).toMatchObject({
        runtimes: [{ found: true, observation: { state: "running" } }],
        orphanedRuntimeIds: [alternateIdentity.runtimeId],
      });
      expect(runs.status(alternateIdentity)).toMatchObject({
        found: true,
        observation: { state: "lost" },
      });
      expect(await runs.stopProject(primaryIdentity.projectId)).toBe(1);
      expect(runs.status(primaryIdentity)).toMatchObject({
        found: true,
        observation: { state: "lost" },
      });
      await runs.closeAll();
    });

    it("stops active processes before a matching target path is removed", async () => {
      const input = await fixture(`
(sleep 0.4; printf survived > removal-orphan.txt) &
while :; do sleep 1; done`);
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      await runs.start(startCommand(input, runtimeIdentity));
      await waitForState(runs, runtimeIdentity, "running");
      expect(await runs.stopForPath(input.targetRoot)).toBe(1);
      expect(runs.status(runtimeIdentity)).toMatchObject({
        found: true,
        observation: { state: "lost" },
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(
        readFile(path.join(input.targetRoot, "removal-orphan.txt")),
      ).rejects.toThrow();
      await runs.closeAll();
    });
  },
);

describe("Run configuration input boundary", () => {
  it("does not expose programmatic stdin", () => {
    const runs = supervisor();
    expect("input" in runs).toBe(false);
  });
});
