import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appLiveServerMessageSchema,
  terminalWireListSchema,
  unavailableCodeCapabilities,
  unprobedCodexRuntimeReport,
  type AppLiveServerMessage,
  type WorkerCommand,
  type WorkerHeartbeat,
  type WorkerNotification,
} from "@cantrip/protocol";
import {
  runConfigurationDeleteResponseSchema,
  runConfigurationDetectResponseSchema,
  runConfigurationFlutterDevicesResponseSchema,
  runConfigurationGetResponseSchema,
  runConfigurationListResponseSchema,
  runConfigurationPathsResponseSchema,
  runConfigurationValidateResponseSchema,
  runConfigurationWriteResponseSchema,
} from "@cantrip/protocol/run-configuration-operations";
import {
  protectedRunConfigurationRuntimeOutputResultSchema,
  runConfigurationRuntimeOperationResultSchema,
  runConfigurationRuntimeStatusResultSchema,
  runConfigurationRuntimeWorkerOperationResultSchema,
  runConfigurationRuntimeWorkerObservationSchema,
  runConfigurationRuntimeWorkerReconciliationSchema,
  type RunConfigurationRuntime,
  type RunConfigurationRuntimeWorkerIdentity,
} from "@cantrip/protocol/run-configuration-runtime";
import {
  runConfigurationSecretListResultSchema,
  runConfigurationSecretSetResultSchema,
} from "@cantrip/protocol/run-configuration-secrets";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { RunConfigurationDefinitionService } from "../../cantrip_worker/src/run-configuration-definition-service.js";
import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type {
  WorkerCommandBus,
  WorkerNotificationListener,
} from "../src/workers/bridge.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-run-configuration-api-"),
);
const primaryRoot = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-run-configuration-primary-")),
);
const alternateRoot = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-run-configuration-alternate-")),
);
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "run-configuration-api-worker-token",
};
const workerId = "run-configuration-api-worker";
const configurationId = "0f82c573-704d-4a06-984e-5ce0b8d688ca";
const listeners = new Set<WorkerNotificationListener>();
const commands: WorkerCommand[] = [];
let connected = true;
let runtimeCommandFailure: Error | null = null;
let reconcileRuntime = (identities: RunConfigurationRuntimeWorkerIdentity[]) =>
  runConfigurationRuntimeWorkerReconciliationSchema.parse({
    runtimes: identities.map((identity) => ({ found: false, identity })),
    orphanedRuntimeIds: [],
  });
const protectedRunOutput = {
  formatVersion: 1 as const,
  domain: "run-content" as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};
const protectedRunSecret = {
  formatVersion: 1 as const,
  keyRevision: 3,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 3,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

const emitNotification = async (
  notification: WorkerNotification,
): Promise<void> => {
  await Promise.all([...listeners].map((listener) => listener(notification)));
};

const definitionService = new RunConfigurationDefinitionService({
  emit: async (notification) => {
    await emitNotification(notification);
    return true;
  },
});

const bridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(id) {
    return connected && id === workerId;
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeNotifications(id, listener) {
    if (id !== workerId) throw new Error(`Unexpected worker ${id}.`);
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(id, command) {
    if (id !== workerId) throw new Error(`Unexpected worker ${id}.`);
    commands.push(command);
    if (
      runtimeCommandFailure &&
      (command.type === "project.run-configuration-runtime.start" ||
        command.type === "project.run-configuration-runtime.restart" ||
        command.type === "project.run-configuration-runtime.stop")
    ) {
      const failure = runtimeCommandFailure;
      runtimeCommandFailure = null;
      throw failure;
    }
    switch (command.type) {
      case "project.run-configuration-definitions.list":
      case "project.run-configuration-definitions.get":
      case "project.run-configuration-definitions.capabilities":
      case "project.run-configuration-definitions.detect":
      case "project.run-configuration-definitions.paths":
      case "project.run-configuration-definitions.flutter-devices":
      case "project.run-configuration-definitions.validate":
      case "project.run-configuration-definitions.write":
      case "project.run-configuration-definitions.delete":
        return definitionService.execute(command);
      case "project.run-configuration-runtime.reconcile":
        return reconcileRuntime(command.identities);
      case "project.run-configuration-runtime.start":
      case "project.run-configuration-runtime.restart":
        return runConfigurationRuntimeWorkerOperationResultSchema.parse({
          outcome: "accepted",
          observation: {
            ...command.identity,
            state: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            exitCode: null,
            signal: null,
            failure: null,
          },
        });
      case "project.run-configuration-runtime.stop":
        return runConfigurationRuntimeWorkerOperationResultSchema.parse({
          outcome: "accepted",
          observation: {
            ...command.identity,
            state: "idle",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            exitCode: null,
            signal: null,
            failure: null,
          },
        });
      case "project.run-configuration-runtime.output":
        return {
          requestOperationId: command.requestOperationId,
          identity: command.identity,
          protectedOutput: protectedRunOutput,
        };
      case "terminal.close":
        return { accepted: true };
      default:
        throw new Error(`Unexpected worker command ${command.type}.`);
    }
  },
};

function heartbeat(): WorkerHeartbeat {
  return {
    workerId,
    name: "Run configuration API worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      iceTransportPolicies: ["all"],
      maxSessions: 4,
    },
    code: unavailableCodeCapabilities,
    startedAt: new Date().toISOString(),
  };
}

function shellDocument(name = "Run API") {
  return {
    schema: "cantrip.run-configuration" as const,
    version: 1 as const,
    id: configurationId,
    name,
    provider: "shell" as const,
    target: { kind: "command" as const, command: "pnpm dev" },
    arguments: ["--listen", "127.0.0.1:4400"],
  };
}

function runtimeObservation(
  runtime: RunConfigurationRuntime,
  state: "running" | "exited",
) {
  return runConfigurationRuntimeWorkerObservationSchema.parse({
    runtimeId: runtime.id,
    projectId: runtime.projectId,
    configurationId: runtime.configurationId,
    worktreeId: runtime.worktreeId,
    workerId: runtime.workerId,
    definitionRevision: runtime.definitionRevision,
    codexEnvironmentRevision: runtime.codexEnvironmentRevision,
    generation: runtime.generation,
    operationId: runtime.requestedOperationId,
    terminalId: runtime.terminalId,
    state,
    startedAt: "2026-08-24T02:00:00.000Z",
    endedAt: state === "exited" ? "2026-08-24T02:01:00.000Z" : null,
    exitCode: state === "exited" ? 0 : null,
    signal: null,
    failure: null,
  });
}

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;

beforeAll(async () => {
  await mkdir(primaryRoot, { recursive: true });
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, heartbeat());
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId,
    ...protectedProjectFields(),
    repositoryBlindIndex: "R".repeat(43),
    repositoryId: "run-configuration-api-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    workerId,
    {
      path: primaryRoot,
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  app = await buildApp({
    config,
    database,
    logger: false,
    workerBridge: bridge,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  definitionService.close();
  await Promise.all([
    rm(dataDirectory, { recursive: true, force: true }),
    rm(primaryRoot, { recursive: true, force: true }),
    rm(alternateRoot, { recursive: true, force: true }),
  ]);
});

describe.sequential("Run configuration definition API", () => {
  it("performs Primary-backed CRUD, capabilities, and static target detection", async () => {
    commands.length = 0;
    const listOperationId = randomUUID();
    const initial = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations?operationId=${listOperationId}`,
    });
    expect(initial.statusCode).toBe(200);
    expect(
      runConfigurationListResponseSchema.parse(initial.json()),
    ).toMatchObject({
      operationId: listOperationId,
      inventory: { entries: [] },
    });

    const capabilities = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/capabilities?operationId=${randomUUID()}`,
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      operation: "capabilities",
      capabilities: expect.arrayContaining([
        expect.objectContaining({ provider: "shell", available: true }),
        expect.objectContaining({
          provider: "node",
          available: true,
          supportsDiscovery: true,
        }),
        expect.objectContaining({
          provider: "java",
          available: true,
          supportsDiscovery: true,
        }),
        expect.objectContaining({
          provider: "dart",
          available: true,
          supportsDiscovery: true,
        }),
        expect.objectContaining({
          provider: "flutter",
          available: true,
          supportsDiscovery: true,
        }),
        expect.objectContaining({
          provider: "rust",
          available: true,
          supportsDiscovery: true,
        }),
      ]),
    });

    await writeFile(
      path.join(primaryRoot, "package.json"),
      JSON.stringify({ name: "api", scripts: { start: "node index.js" } }),
    );
    await writeFile(
      path.join(primaryRoot, "index.js"),
      "console.log('ready')\n",
    );
    const detectionOperationId = randomUUID();
    const detected = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/detect?operationId=${detectionOperationId}&provider=node`,
    });
    expect(detected.statusCode).toBe(200);
    expect(
      runConfigurationDetectResponseSchema.parse(detected.json()),
    ).toMatchObject({
      operationId: detectionOperationId,
      candidates: expect.arrayContaining([
        expect.objectContaining({
          provider: "node",
          confidence: "high",
          effectiveCommand: "npm run start",
        }),
      ]),
    });

    const validationOperationId = randomUUID();
    const validated = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/run-configurations/validate`,
      payload: {
        operationId: validationOperationId,
        document: shellDocument(),
      },
    });
    expect(validated.statusCode).toBe(200);
    expect(
      runConfigurationValidateResponseSchema.parse(validated.json()),
    ).toMatchObject({
      operation: "validate",
      operationId: validationOperationId,
      projectId,
      validation: {
        configurationId,
        provider: "shell",
        valid: true,
        effectiveCommand: expect.stringContaining("pnpm dev"),
        diagnostics: [],
      },
    });
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "project.run-configuration-definitions.validate",
        operationId: validationOperationId,
        projectId,
        sourcePath: primaryRoot,
        document: expect.objectContaining({ id: configurationId }),
      }),
    );
    const invalidValidation = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/run-configurations/validate`,
      payload: {
        operationId: randomUUID(),
        document: {
          ...shellDocument(),
          target: { kind: "command", command: "" },
        },
      },
    });
    expect(invalidValidation.statusCode).toBe(400);

    const pathsOperationId = randomUUID();
    const paths = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/paths?operationId=${pathsOperationId}&purpose=file&query=index`,
    });
    expect(paths.statusCode).toBe(200);
    expect(runConfigurationPathsResponseSchema.parse(paths.json())).toEqual({
      operation: "paths",
      operationId: pathsOperationId,
      projectId,
      purpose: "file",
      query: "index",
      suggestions: [{ kind: "file", path: "index.js" }],
      truncated: false,
    });
    expect(commands).toContainEqual({
      type: "project.run-configuration-definitions.paths",
      operationId: pathsOperationId,
      projectId,
      sourcePath: primaryRoot,
      purpose: "file",
      query: "index",
    });
    const invalidPaths = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/paths?operationId=${randomUUID()}&purpose=absolute`,
    });
    expect(invalidPaths.statusCode).toBe(400);

    await mkdir(path.join(primaryRoot, "java", "src", "main", "java", "demo"), {
      recursive: true,
    });
    await writeFile(
      path.join(primaryRoot, "java", "settings.gradle"),
      "rootProject.name = 'java-api'\n",
    );
    await writeFile(
      path.join(primaryRoot, "java", "build.gradle"),
      "plugins { id 'application' }\napplication { mainClass = 'demo.Main' }\n",
    );
    await writeFile(
      path.join(
        primaryRoot,
        "java",
        "src",
        "main",
        "java",
        "demo",
        "Main.java",
      ),
      "package demo; public class Main { public static void main(String[] args) {} }\n",
    );
    const javaDetectedResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/detect?operationId=${randomUUID()}&provider=java`,
    });
    expect(javaDetectedResponse.statusCode).toBe(200);
    const javaDetected = runConfigurationDetectResponseSchema.parse(
      javaDetectedResponse.json(),
    );
    const javaCandidate = javaDetected.candidates.find(
      ({ document }) =>
        document.provider === "java" &&
        document.target.kind === "gradleMainClass",
    );
    if (!javaCandidate) throw new Error("Expected a detected Java main class.");
    expect(javaCandidate).toMatchObject({
      confidence: "high",
      effectiveCommand: expect.stringContaining("demo.Main"),
      document: {
        provider: "java",
        workingDirectory: "java",
        target: { kind: "gradleMainClass", className: "demo.Main" },
      },
    });
    const javaCreatedResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configurations/${javaCandidate.document.id}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: null,
        document: javaCandidate.document,
      },
    });
    expect(javaCreatedResponse.statusCode).toBe(201);
    const javaCreated = runConfigurationWriteResponseSchema.parse(
      javaCreatedResponse.json(),
    );
    if (
      !("entry" in javaCreated.result) ||
      !javaCreated.result.entry.revision
    ) {
      throw new Error("Expected a saved Java definition.");
    }
    const javaDeletedResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/run-configurations/${javaCandidate.document.id}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: javaCreated.result.entry.revision,
      },
    });
    expect(javaDeletedResponse.statusCode).toBe(200);

    await mkdir(path.join(primaryRoot, "dart", "bin"), { recursive: true });
    await writeFile(
      path.join(primaryRoot, "dart", "pubspec.yaml"),
      "name: dart_api\n",
    );
    await writeFile(
      path.join(primaryRoot, "dart", "bin", "dart_api.dart"),
      "void main(List<String> arguments) {}\n",
    );
    const dartDetectedResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/detect?operationId=${randomUUID()}&provider=dart`,
    });
    expect(dartDetectedResponse.statusCode).toBe(200);
    const dartDetected = runConfigurationDetectResponseSchema.parse(
      dartDetectedResponse.json(),
    );
    const dartCandidate = dartDetected.candidates.find(
      ({ document }) => document.provider === "dart",
    );
    if (!dartCandidate) throw new Error("Expected a detected Dart entrypoint.");
    expect(dartCandidate).toMatchObject({
      confidence: "high",
      effectiveCommand: "dart run bin/dart_api.dart",
      document: {
        provider: "dart",
        workingDirectory: "dart",
        target: { kind: "entrypoint", path: "bin/dart_api.dart" },
      },
    });
    const dartCreatedResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configurations/${dartCandidate.document.id}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: null,
        document: dartCandidate.document,
      },
    });
    expect(dartCreatedResponse.statusCode).toBe(201);
    const dartCreated = runConfigurationWriteResponseSchema.parse(
      dartCreatedResponse.json(),
    );
    if (
      !("entry" in dartCreated.result) ||
      !dartCreated.result.entry.revision
    ) {
      throw new Error("Expected a saved Dart definition.");
    }
    const dartDeletedResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/run-configurations/${dartCandidate.document.id}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: dartCreated.result.entry.revision,
      },
    });
    expect(dartDeletedResponse.statusCode).toBe(200);

    await mkdir(path.join(primaryRoot, "flutter", "lib"), { recursive: true });
    await writeFile(
      path.join(primaryRoot, "flutter", "pubspec.yaml"),
      [
        "name: mobile",
        "dependencies:",
        "  flutter:",
        "    sdk: flutter",
        "flutter:",
        "  default-flavor: staging",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(primaryRoot, "flutter", "lib", "main.dart"),
      "void main() {}\n",
    );
    const flutterDetectedResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/detect?operationId=${randomUUID()}&provider=flutter`,
    });
    expect(flutterDetectedResponse.statusCode).toBe(200);
    const flutterDetected = runConfigurationDetectResponseSchema.parse(
      flutterDetectedResponse.json(),
    );
    const flutterCandidate = flutterDetected.candidates.find(
      ({ document }) => document.provider === "flutter",
    );
    if (!flutterCandidate) {
      throw new Error("Expected a detected Flutter entrypoint.");
    }
    expect(flutterCandidate).toMatchObject({
      confidence: "high",
      effectiveCommand:
        "flutter run --debug --target=lib/main.dart --flavor=staging --pub",
      document: {
        provider: "flutter",
        workingDirectory: "flutter",
        target: { kind: "entrypoint", path: "lib/main.dart" },
        options: expect.objectContaining({ flavor: "staging" }),
      },
    });
    const flutterDevicesOperationId = randomUUID();
    const flutterDevicesResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/run-configurations/flutter-devices`,
      payload: {
        operationId: flutterDevicesOperationId,
        document: {
          ...flutterCandidate.document,
          options: {
            ...flutterCandidate.document.options,
            sdkHome: path.join(primaryRoot, "missing-flutter-sdk"),
          },
        },
      },
    });
    expect(flutterDevicesResponse.statusCode).toBe(200);
    expect(
      runConfigurationFlutterDevicesResponseSchema.parse(
        flutterDevicesResponse.json(),
      ),
    ).toMatchObject({
      operation: "flutter-devices",
      operationId: flutterDevicesOperationId,
      projectId,
      configurationId: flutterCandidate.document.id,
      devices: [],
      diagnostics: [
        expect.objectContaining({
          severity: "error",
          code: "flutter-sdk-invalid",
          field: "options.sdkHome",
        }),
      ],
    });
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "project.run-configuration-definitions.flutter-devices",
        operationId: flutterDevicesOperationId,
        projectId,
        sourcePath: primaryRoot,
        document: expect.objectContaining({
          id: flutterCandidate.document.id,
          provider: "flutter",
        }),
      }),
    );
    const flutterCreatedResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configurations/${flutterCandidate.document.id}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: null,
        document: flutterCandidate.document,
      },
    });
    expect(flutterCreatedResponse.statusCode).toBe(201);
    const flutterCreated = runConfigurationWriteResponseSchema.parse(
      flutterCreatedResponse.json(),
    );
    if (
      !("entry" in flutterCreated.result) ||
      !flutterCreated.result.entry.revision
    ) {
      throw new Error("Expected a saved Flutter definition.");
    }
    const flutterDeletedResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/run-configurations/${flutterCandidate.document.id}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: flutterCreated.result.entry.revision,
      },
    });
    expect(flutterDeletedResponse.statusCode).toBe(200);

    await mkdir(path.join(primaryRoot, "rust", "src"), { recursive: true });
    await writeFile(
      path.join(primaryRoot, "rust", "Cargo.toml"),
      '[package]\nname = "rust_api"\nversion = "0.1.0"\n',
    );
    await writeFile(
      path.join(primaryRoot, "rust", "src", "main.rs"),
      "fn main() {}\n",
    );
    const rustDetectedResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/detect?operationId=${randomUUID()}&provider=rust`,
    });
    expect(rustDetectedResponse.statusCode).toBe(200);
    const rustDetected = runConfigurationDetectResponseSchema.parse(
      rustDetectedResponse.json(),
    );
    const rustCandidate = rustDetected.candidates.find(
      ({ document }) => document.provider === "rust",
    );
    if (!rustCandidate) {
      throw new Error("Expected a detected Rust binary.");
    }
    expect(rustCandidate).toMatchObject({
      confidence: "high",
      effectiveCommand: "cargo run --package=rust_api --bin=rust_api",
      document: {
        provider: "rust",
        workingDirectory: "rust",
        target: { kind: "binary", package: "rust_api", name: "rust_api" },
      },
    });
    const rustCreatedResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configurations/${rustCandidate.document.id}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: null,
        document: rustCandidate.document,
      },
    });
    expect(rustCreatedResponse.statusCode).toBe(201);
    const rustCreated = runConfigurationWriteResponseSchema.parse(
      rustCreatedResponse.json(),
    );
    if (
      !("entry" in rustCreated.result) ||
      !rustCreated.result.entry.revision
    ) {
      throw new Error("Expected a saved Rust definition.");
    }
    const rustDeletedResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/run-configurations/${rustCandidate.document.id}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: rustCreated.result.entry.revision,
      },
    });
    expect(rustDeletedResponse.statusCode).toBe(200);

    const createOperationId = randomUUID();
    const created = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}`,
      payload: {
        operationId: createOperationId,
        expectedRevision: null,
        document: shellDocument(),
      },
    });
    expect(created.statusCode).toBe(201);
    const createdResult = runConfigurationWriteResponseSchema.parse(
      created.json(),
    );
    if (!("entry" in createdResult.result)) {
      throw new Error("Expected a created definition.");
    }
    expect(createdResult.result).toMatchObject({
      outcome: "created",
      entry: {
        document: { arguments: ["--listen", "127.0.0.1:4400"] },
      },
    });
    const revision = createdResult.result.entry.revision!;

    const read = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}?operationId=${randomUUID()}`,
    });
    expect(read.statusCode).toBe(200);
    expect(runConfigurationGetResponseSchema.parse(read.json())).toMatchObject({
      result: { found: true, entry: { revision } },
    });

    const stale = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: "b".repeat(64),
        document: shellDocument("Changed"),
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      runConfigurationWriteResponseSchema.parse(stale.json()),
    ).toMatchObject({
      result: { outcome: "revision-mismatch", currentRevision: revision },
    });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: revision,
        document: shellDocument("Changed"),
      },
    });
    expect(updated.statusCode).toBe(200);
    const updatedResult = runConfigurationWriteResponseSchema.parse(
      updated.json(),
    );
    if (!("entry" in updatedResult.result)) {
      throw new Error("Expected an updated definition.");
    }
    expect(updatedResult.result).toMatchObject({
      outcome: "updated",
      entry: { document: { name: "Changed" } },
    });
    const updatedRevision = updatedResult.result.entry.revision!;
    expect(updatedRevision).not.toBe(revision);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: updatedRevision,
      },
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      runConfigurationDeleteResponseSchema.parse(deleted.json()),
    ).toMatchObject({ result: { outcome: "deleted", id: configurationId } });
    expect(
      commands.every(
        (command) =>
          !("sourcePath" in command) || command.sourcePath === primaryRoot,
      ),
    ).toBe(true);
  });

  it("turns an external Primary edit into a project live invalidation", async () => {
    const operationId = randomUUID();
    const created = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}`,
      payload: {
        operationId,
        expectedRevision: null,
        document: shellDocument(),
      },
    });
    expect(created.statusCode).toBe(201);

    const messages: AppLiveServerMessage[] = [];
    let clientSocket: WebSocket | null = null;
    const socket = await app.injectWS(
      "/api/live",
      { headers: { origin: config.appOrigins[0] } },
      {
        onInit(client) {
          clientSocket = client;
          client.on("message", (data) => {
            messages.push(
              appLiveServerMessageSchema.parse(JSON.parse(data.toString())),
            );
          });
        },
      },
    );
    if (!clientSocket) throw new Error("Live socket did not initialize.");
    clientSocket.send(
      JSON.stringify({
        type: "initialize",
        protocolVersion: 1,
        client: { id: "run-config-api", name: "API test", version: "1" },
        resume: null,
      }),
    );
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "ready")).toBe(true),
    );
    clientSocket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: "run-configurations",
        scopes: [{ kind: "project", projectId }],
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.some(
          (message) =>
            message.type === "subscribed" &&
            message.requestId === "run-configurations",
        ),
      ).toBe(true),
    );

    await new Promise((resolve) => setTimeout(resolve, 650));
    const before = messages.filter(
      (message) =>
        message.type === "event" && message.resource === "run-configuration",
    ).length;
    const file = path.join(
      primaryRoot,
      ".cantrip",
      "run-configurations",
      `${configurationId}.json`,
    );
    const external = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    external.name = "Externally Changed";
    await writeFile(file, JSON.stringify(external, null, 2) + "\n", "utf8");

    await vi.waitFor(
      () =>
        expect(
          messages.filter(
            (message) =>
              message.type === "event" &&
              message.resource === "run-configuration" &&
              message.entityId === configurationId,
          ).length,
        ).toBeGreaterThan(before),
      { timeout: 3_000 },
    );
    socket.terminate();
  }, 15_000);

  it("stores write-only project secrets idempotently and exposes only availability metadata", async () => {
    const read = runConfigurationGetResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/run-configurations/${configurationId}?operationId=${randomUUID()}`,
        })
      ).json(),
    );
    if (
      !read.result.found ||
      read.result.entry.status !== "ready" ||
      !read.result.entry.document ||
      !read.result.entry.revision
    ) {
      throw new Error("Expected a ready Run configuration.");
    }
    const updated = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: read.result.entry.revision,
        document: {
          ...read.result.entry.document,
          environment: {
            ...read.result.entry.document.environment,
            secrets: [
              {
                name: "DATABASE_URL",
                secret: "project/database-url",
                enabled: true,
              },
            ],
          },
        },
      },
    });
    expect(updated.statusCode).toBe(200);

    const missingRead = runConfigurationGetResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/run-configurations/${configurationId}?operationId=${randomUUID()}`,
        })
      ).json(),
    );
    expect(missingRead.secretReferences).toEqual([
      {
        reference: "project/database-url",
        available: false,
        revision: null,
        updatedAt: null,
      },
    ]);

    const operationId = randomUUID();
    const created = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configuration-secrets`,
      payload: {
        operationId,
        reference: "project/database-url",
        protectedValue: protectedRunSecret,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(
      runConfigurationSecretSetResultSchema.parse(created.json()),
    ).toMatchObject({
      replayed: false,
      secret: { available: true, revision: 1 },
    });

    const replayed = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configuration-secrets`,
      payload: {
        operationId,
        reference: "project/database-url",
        protectedValue: protectedRunSecret,
      },
    });
    expect(replayed.statusCode).toBe(200);
    expect(
      runConfigurationSecretSetResultSchema.parse(replayed.json()),
    ).toMatchObject({ replayed: true, secret: { revision: 1 } });

    const rotatedProtectedValue = {
      ...protectedRunSecret,
      envelope: {
        ...protectedRunSecret.envelope,
        ciphertext: "BBBBBBBBBBBBBBBBBBBBBA",
      },
    };
    const rotated = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-configuration-secrets`,
      payload: {
        operationId: randomUUID(),
        reference: "project/database-url",
        protectedValue: rotatedProtectedValue,
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect(
      runConfigurationSecretSetResultSchema.parse(rotated.json()),
    ).toMatchObject({ replayed: false, secret: { revision: 2 } });

    const listedResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configuration-secrets`,
    });
    const listed = runConfigurationSecretListResultSchema.parse(
      listedResponse.json(),
    );
    expect(listed.secrets).toMatchObject([
      { reference: "project/database-url", available: true, revision: 2 },
    ]);
    expect(JSON.stringify(listed)).not.toContain("protectedValue");
    expect(JSON.stringify(listed)).not.toContain("ciphertext");

    const definitionResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}?operationId=${randomUUID()}`,
    });
    expect(definitionResponse.json()).toMatchObject({
      secretReferences: [
        {
          reference: "project/database-url",
          available: true,
          revision: 2,
        },
      ],
    });
    expect(JSON.stringify(definitionResponse.json())).not.toContain(
      "protectedValue",
    );

    const internal =
      await database.repository.listRunConfigurationProtectedSecrets(
        LOCAL_USER_ID,
        projectId,
        ["project/database-url"],
      );
    expect(internal).toMatchObject([
      { revision: 2, protectedValue: rotatedProtectedValue },
    ]);
    expect(JSON.stringify(internal)).not.toContain("secret-plaintext-sentinel");
    const audits = await database.repository.listAuditEvents(
      { limit: 100 },
      LOCAL_USER_ID,
    );
    expect(audits.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "run.configuration.secret.app.set",
          resource: {
            type: "run-configuration-secret",
            id: "project/database-url",
          },
        }),
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain("protectedValue");
    expect(JSON.stringify(audits)).not.toContain("ciphertext");
  });

  it("runs, restarts, stops, reports, and reuses a Primary-bound Run terminal", async () => {
    const codexEnvironmentDirectory = path.join(
      primaryRoot,
      ".codex",
      "environments",
    );
    const codexEnvironmentPath = path.join(
      codexEnvironmentDirectory,
      "environment.toml",
    );
    await mkdir(codexEnvironmentDirectory, { recursive: true });
    await writeFile(
      codexEnvironmentPath,
      `[setup]
script = "export SERVER_PREFLIGHT=first"
`,
    );
    commands.length = 0;
    const startOperationId = randomUUID();
    const startedResponse = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "start",
        operationId: startOperationId,
        projectId,
        configurationId,
        targetWorktreeId: null,
      },
    });
    expect(startedResponse.statusCode).toBe(202);
    const started = runConfigurationRuntimeOperationResultSchema.parse(
      startedResponse.json(),
    );
    expect(started).toMatchObject({
      replayed: false,
      operation: { operation: "start", outcome: "accepted", generation: 1 },
      runtime: { state: "running", generation: 1 },
    });
    const firstCodexRevision = started.runtime?.codexEnvironmentRevision;
    expect(firstCodexRevision).toMatch(/^[0-9a-f]{64}$/u);
    expect(started.runtime?.terminalId).toBe(started.runtime?.id);
    const terminalId = started.runtime?.terminalId;
    if (!terminalId || !started.runtime) throw new Error("Expected a runtime.");
    expect(
      commands.find(
        (command) => command.type === "project.run-configuration-runtime.start",
      ),
    ).toMatchObject({
      sourcePath: primaryRoot,
      targetPath: primaryRoot,
      identity: { terminalId, generation: 1 },
      protectedSecrets: [
        {
          reference: "project/database-url",
          revision: 2,
          protectedValue: {
            envelope: { ciphertext: "BBBBBBBBBBBBBBBBBBBBBA" },
          },
        },
      ],
    });

    const terminals = terminalWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/terminals`,
        })
      ).json(),
    );
    expect(terminals).toContainEqual(
      expect.objectContaining({
        id: terminalId,
        kind: "run-configuration",
        runConfigurationId: configurationId,
        runConfigurationRuntimeId: started.runtime.id,
        titleProtection: null,
        stateProtection: null,
        status: "running",
      }),
    );
    const direct = await app.inject({
      method: "POST",
      url: `/api/terminals/${terminalId}/direct`,
      payload: { clientId: randomUUID() },
    });
    expect(direct.statusCode).toBe(409);
    expect(direct.json()).toMatchObject({
      error: expect.stringMatching(/read-only/u),
    });

    const startsBeforeReplay = commands.filter(
      (command) => command.type === "project.run-configuration-runtime.start",
    ).length;
    const replayedResponse = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "start",
        operationId: startOperationId,
        projectId,
        configurationId,
        targetWorktreeId: null,
      },
    });
    expect(replayedResponse.statusCode).toBe(200);
    expect(
      runConfigurationRuntimeOperationResultSchema.parse(
        replayedResponse.json(),
      ),
    ).toMatchObject({ replayed: true, runtime: { state: "running" } });
    expect(
      commands.filter(
        (command) => command.type === "project.run-configuration-runtime.start",
      ),
    ).toHaveLength(startsBeforeReplay);

    const status = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/status",
      payload: {
        operationId: randomUUID(),
        projectId,
        configurationId,
        targetWorktreeId: null,
        limit: 10,
      },
    });
    expect(status.statusCode).toBe(200);
    expect(
      runConfigurationRuntimeStatusResultSchema.parse(status.json()),
    ).toMatchObject({
      projectId,
      runtimes: [
        expect.objectContaining({ id: started.runtime.id, state: "running" }),
      ],
    });

    const outputOperationId = randomUUID();
    const output = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/output",
      payload: {
        operationId: outputOperationId,
        projectId,
        configurationId,
        worktreeId: started.runtime.worktreeId,
        tail: 4_096,
      },
    });
    expect(output.statusCode).toBe(200);
    expect(
      protectedRunConfigurationRuntimeOutputResultSchema.parse(output.json()),
    ).toEqual({
      operationId: outputOperationId,
      projectId,
      configurationId,
      worktreeId: started.runtime.worktreeId,
      generation: 1,
      protectedOutput: protectedRunOutput,
    });

    await writeFile(
      codexEnvironmentPath,
      `[setup]
script = "export SERVER_PREFLIGHT=second"
`,
    );
    const restartedResponse = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "restart",
        operationId: randomUUID(),
        projectId,
        configurationId,
        targetWorktreeId: null,
      },
    });
    expect(restartedResponse.statusCode).toBe(202);
    const restarted = runConfigurationRuntimeOperationResultSchema.parse(
      restartedResponse.json(),
    );
    expect(restarted).toMatchObject({
      runtime: { terminalId, generation: 2, state: "running" },
    });
    expect(restarted.runtime?.codexEnvironmentRevision).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(restarted.runtime?.codexEnvironmentRevision).not.toBe(
      firstCodexRevision,
    );
    expect(
      commands
        .filter(
          (command) =>
            command.type === "project.run-configuration-runtime.restart",
        )
        .at(-1),
    ).toMatchObject({
      identity: {
        codexEnvironmentRevision: restarted.runtime?.codexEnvironmentRevision,
        generation: 2,
      },
    });

    const stoppedResponse = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "stop",
        operationId: randomUUID(),
        projectId,
        configurationId,
        targetWorktreeId: null,
      },
    });
    expect(stoppedResponse.statusCode).toBe(202);
    expect(
      runConfigurationRuntimeOperationResultSchema.parse(
        stoppedResponse.json(),
      ),
    ).toMatchObject({
      runtime: { terminalId, generation: 2, state: "idle" },
    });

    await rm(codexEnvironmentPath);
    const startedAgainResponse = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "start",
        operationId: randomUUID(),
        projectId,
        configurationId,
        targetWorktreeId: null,
      },
    });
    expect(startedAgainResponse.statusCode).toBe(202);
    expect(
      runConfigurationRuntimeOperationResultSchema.parse(
        startedAgainResponse.json(),
      ),
    ).toMatchObject({
      runtime: {
        terminalId,
        codexEnvironmentRevision: null,
        generation: 3,
        state: "running",
      },
    });

    const finalStop = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "stop",
        operationId: randomUUID(),
        projectId,
        configurationId,
        targetWorktreeId: null,
      },
    });
    expect(finalStop.statusCode).toBe(202);
    await rm(codexEnvironmentDirectory, { recursive: true, force: true });
  });

  it("rejects an invalid enabled Codex environment before committing a generation", async () => {
    const codexEnvironmentDirectory = path.join(
      primaryRoot,
      ".codex",
      "environments",
    );
    await mkdir(codexEnvironmentDirectory, { recursive: true });
    await writeFile(
      path.join(codexEnvironmentDirectory, "environment.toml"),
      `[setup]
script = ""
`,
    );
    commands.length = 0;
    const response = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "start",
        operationId: randomUUID(),
        projectId,
        configurationId,
        targetWorktreeId: null,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: expect.stringMatching(/setup\.script/u),
    });
    expect(
      commands.some(
        ({ type }) => type === "project.run-configuration-runtime.start",
      ),
    ).toBe(false);
    await rm(codexEnvironmentDirectory, { recursive: true, force: true });
  });

  it("fails a committed generation closed when worker dispatch is lost", async () => {
    const operationId = randomUUID();
    const before = commands.length;
    runtimeCommandFailure = new Error("Worker disconnected during launch.");
    const failed = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "start",
        operationId,
        projectId,
        configurationId,
        targetWorktreeId: null,
      },
    });
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    const worktrees = await database.repository.listProjectWorktrees(
      LOCAL_USER_ID,
      projectId,
    );
    const primary = worktrees.find((worktree) => worktree.isPrimary);
    if (!primary) throw new Error("Expected a Primary worktree.");
    await expect
      .poll(() =>
        database.repository.getRunConfigurationRuntime(
          LOCAL_USER_ID,
          projectId,
          configurationId,
          primary.id,
        ),
      )
      .toMatchObject({
        state: "failed",
        failure: { phase: "spawn", code: "worker-request-failed" },
      });

    const replayed = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "start",
        operationId,
        projectId,
        configurationId,
        targetWorktreeId: null,
      },
    });
    expect(replayed.statusCode).toBe(200);
    expect(
      runConfigurationRuntimeOperationResultSchema.parse(replayed.json()),
    ).toMatchObject({
      replayed: true,
      runtime: { state: "failed" },
    });
    expect(
      commands
        .slice(before)
        .filter(
          (command) =>
            command.type === "project.run-configuration-runtime.start",
        ),
    ).toHaveLength(1);
  });

  it("uses an explicitly selected worktree while still reading Primary definitions", async () => {
    const worktrees = await database.repository.listProjectWorktrees(
      LOCAL_USER_ID,
      projectId,
    );
    const primary = worktrees.find((worktree) => worktree.isPrimary);
    if (!primary) throw new Error("Expected a Primary worktree.");
    const alternateId = randomUUID();
    await database.repository.reconcileProjectWorktrees(
      LOCAL_USER_ID,
      projectId,
      workerId,
      {
        sourcePath: primaryRoot,
        primaryPath: primaryRoot,
        gitCommonDir: path.join(primaryRoot, ".git"),
        managedRoot: path.join(dataDirectory, "worktrees"),
        repositoryFingerprint: "c".repeat(64),
        worktrees: [
          {
            path: primaryRoot,
            head: "1".repeat(40),
            branch: "main",
            detached: false,
            isPrimary: true,
            managed: false,
            locked: false,
            lockReason: null,
            prunable: false,
            pruneReason: null,
            missing: false,
          },
          {
            path: alternateRoot,
            head: "2".repeat(40),
            branch: "feature/run-target",
            detached: false,
            isPrimary: false,
            managed: true,
            locked: false,
            lockReason: null,
            prunable: false,
            pruneReason: null,
            missing: false,
          },
        ],
      },
      {
        id: alternateId,
        name: "Run target",
        origin: "user",
        path: alternateRoot,
      },
    );
    commands.length = 0;
    const started = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "start",
        operationId: randomUUID(),
        projectId,
        configurationId,
        targetWorktreeId: alternateId,
      },
    });
    expect(started.statusCode).toBe(202);
    const runtime = runConfigurationRuntimeOperationResultSchema.parse(
      started.json(),
    ).runtime;
    expect(runtime).toMatchObject({
      worktreeId: alternateId,
      state: "running",
    });
    expect(
      commands.find(
        (command) => command.type === "project.run-configuration-runtime.start",
      ),
    ).toMatchObject({ sourcePath: primaryRoot, targetPath: alternateRoot });
    const stopped = await app.inject({
      method: "POST",
      url: "/api/run-configuration-runtimes/operations",
      payload: {
        operation: "stop",
        operationId: randomUUID(),
        projectId,
        configurationId,
        targetWorktreeId: alternateId,
      },
    });
    expect(stopped.statusCode).toBe(202);
  });

  it("keeps captured generations controllable when Primary removes their definition externally", async () => {
    const definitionPath = path.join(
      primaryRoot,
      ".cantrip",
      "run-configurations",
      `${configurationId}.json`,
    );
    const definition = await readFile(definitionPath, "utf8");
    const worktrees = await database.repository.listProjectWorktrees(
      LOCAL_USER_ID,
      projectId,
    );
    const primary = worktrees.find(({ isPrimary }) => isPrimary);
    const alternate = worktrees.find(({ isPrimary }) => !isPrimary);
    if (!primary || !alternate) throw new Error("Expected both Run targets.");

    const started = await Promise.all(
      [null, alternate.id].map(async (targetWorktreeId) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/run-configuration-runtimes/operations",
          payload: {
            operation: "start",
            operationId: randomUUID(),
            projectId,
            configurationId,
            targetWorktreeId,
          },
        });
        expect(response.statusCode).toBe(202);
        const runtime = runConfigurationRuntimeOperationResultSchema.parse(
          response.json(),
        ).runtime;
        if (!runtime) throw new Error("Expected a running generation.");
        return runtime;
      }),
    );
    const primaryRuntime = started.find(
      ({ worktreeId }) => worktreeId === primary.id,
    );
    const alternateRuntime = started.find(
      ({ worktreeId }) => worktreeId === alternate.id,
    );
    if (!primaryRuntime || !alternateRuntime) {
      throw new Error("Expected Primary and alternate Run generations.");
    }

    commands.length = 0;
    await rm(definitionPath);
    try {
      await expect
        .poll(async () => {
          const response = await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/run-configurations/${configurationId}?operationId=${randomUUID()}`,
          });
          return runConfigurationGetResponseSchema.parse(response.json()).result
            .found;
        })
        .toBe(false);
      expect(
        commands.some(
          ({ type }) => type === "project.run-configuration-runtime.stop",
        ),
      ).toBe(false);

      const restart = await app.inject({
        method: "POST",
        url: "/api/run-configuration-runtimes/operations",
        payload: {
          operation: "restart",
          operationId: randomUUID(),
          projectId,
          configurationId,
          targetWorktreeId: null,
        },
      });
      expect(restart.statusCode).toBe(404);
      expect(restart.json()).toMatchObject({
        error: expect.stringMatching(/not found in Primary/iu),
      });
      expect(
        commands.some(
          ({ type }) => type === "project.run-configuration-runtime.restart",
        ),
      ).toBe(false);
      await expect(
        database.repository.getRunConfigurationRuntime(
          LOCAL_USER_ID,
          projectId,
          configurationId,
          primary.id,
        ),
      ).resolves.toMatchObject({ state: "running" });

      const stopped = await app.inject({
        method: "POST",
        url: "/api/run-configuration-runtimes/operations",
        payload: {
          operation: "stop",
          operationId: randomUUID(),
          projectId,
          configurationId,
          targetWorktreeId: null,
        },
      });
      expect(stopped.statusCode).toBe(202);
      expect(
        runConfigurationRuntimeOperationResultSchema.parse(stopped.json()),
      ).toMatchObject({ runtime: { state: "idle" } });

      await emitNotification({
        type: "project.run-configuration-runtime.observed",
        observation: runtimeObservation(alternateRuntime, "exited"),
      });
      await expect(
        database.repository.getRunConfigurationRuntime(
          LOCAL_USER_ID,
          projectId,
          configurationId,
          alternate.id,
        ),
      ).resolves.toMatchObject({ state: "exited", exitCode: 0 });
      const terminals = terminalWireListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/terminals`,
          })
        ).json(),
      );
      expect(
        terminals.filter(
          ({ runConfigurationId }) => runConfigurationId === configurationId,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: primaryRuntime.terminalId,
            status: "exited",
          }),
          expect.objectContaining({
            id: alternateRuntime.terminalId,
            status: "exited",
          }),
        ]),
      );
    } finally {
      await writeFile(definitionPath, definition, "utf8");
    }
    await expect
      .poll(async () => {
        const response = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/run-configurations/${configurationId}?operationId=${randomUUID()}`,
        });
        return runConfigurationGetResponseSchema.parse(response.json()).result
          .found;
      })
      .toBe(true);
  }, 15_000);

  it("preflights revision conflicts, then stops every instance and removes managed terminals before deleting", async () => {
    const inventory = runConfigurationGetResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/run-configurations/${configurationId}?operationId=${randomUUID()}`,
        })
      ).json(),
    );
    if (!inventory.result.found || !inventory.result.entry.revision) {
      throw new Error("Expected the shared Run configuration.");
    }
    const worktrees = await database.repository.listProjectWorktrees(
      LOCAL_USER_ID,
      projectId,
    );
    const primary = worktrees.find(({ isPrimary }) => isPrimary);
    const alternate = worktrees.find(({ isPrimary }) => !isPrimary);
    if (!primary || !alternate) throw new Error("Expected both Run targets.");
    for (const targetWorktreeId of [null, alternate.id]) {
      const started = await app.inject({
        method: "POST",
        url: "/api/run-configuration-runtimes/operations",
        payload: {
          operation: "start",
          operationId: randomUUID(),
          projectId,
          configurationId,
          targetWorktreeId,
        },
      });
      expect(started.statusCode).toBe(202);
    }

    commands.length = 0;
    const stale = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: "b".repeat(64),
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      commands.filter(
        ({ type }) => type === "project.run-configuration-runtime.stop",
      ),
    ).toHaveLength(0);

    commands.length = 0;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/run-configurations/${configurationId}`,
      payload: {
        operationId: randomUUID(),
        expectedRevision: inventory.result.entry.revision,
      },
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      runConfigurationDeleteResponseSchema.parse(deleted.json()),
    ).toMatchObject({ result: { outcome: "deleted" } });
    const stopIndexes = commands.flatMap((command, index) =>
      command.type === "project.run-configuration-runtime.stop" ? [index] : [],
    );
    const deleteIndex = commands.findIndex(
      ({ type }) => type === "project.run-configuration-definitions.delete",
    );
    expect(stopIndexes).toHaveLength(2);
    expect(stopIndexes.every((index) => index < deleteIndex)).toBe(true);
    expect(
      await database.repository.listRunConfigurationRuntimes(
        LOCAL_USER_ID,
        projectId,
        { configurationId },
      ),
    ).toEqual([]);
    const terminals = terminalWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/terminals`,
        })
      ).json(),
    );
    expect(
      terminals.filter(
        (terminal) => terminal.runConfigurationId === configurationId,
      ),
    ).toEqual([]);
  });

  it("rejects invalid IDs before worker dispatch and does not route offline", async () => {
    const before = commands.length;
    const invalid = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations/not-a-uuid?operationId=${randomUUID()}`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(commands).toHaveLength(before);

    connected = false;
    try {
      const offline = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/run-configurations?operationId=${randomUUID()}`,
      });
      expect(offline.statusCode).toBe(503);
      const lifecycleOffline = await app.inject({
        method: "POST",
        url: "/api/run-configuration-runtimes/operations",
        payload: {
          operation: "start",
          operationId: randomUUID(),
          projectId,
          configurationId,
          targetWorktreeId: null,
        },
      });
      expect(lifecycleOffline.statusCode).toBe(503);
    } finally {
      connected = true;
    }
    expect(commands).toHaveLength(before);
  });

  it("applies runtime observations and reconciles missing or unclaimed generations on reconnect", async () => {
    const worktrees = await database.repository.listProjectWorktrees(
      LOCAL_USER_ID,
      projectId,
    );
    const primary = worktrees[0];
    if (!primary) throw new Error("Expected a Primary worktree.");
    const runtimeConfigurationId = randomUUID();
    const operationId = randomUUID();
    const requested =
      await database.repository.requestRunConfigurationRuntimeOperation(
        LOCAL_USER_ID,
        {
          operation: "start",
          operationId,
          projectId,
          configurationId: runtimeConfigurationId,
          worktreeId: primary.id,
          workerId,
          definitionRevision: "d".repeat(64),
          codexEnvironmentRevision: null,
        },
      );
    if (!requested.runtime) throw new Error("Expected a runtime.");

    // A definition request establishes the same worker notification
    // subscription used by the persistent worker connection.
    const subscribed = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-configurations?operationId=${randomUUID()}`,
    });
    expect(subscribed.statusCode).toBe(200);
    await emitNotification({
      type: "project.run-configuration-runtime.observed",
      observation: runtimeObservation(requested.runtime, "running"),
    });
    await expect
      .poll(() =>
        database.repository.getRunConfigurationRuntime(
          LOCAL_USER_ID,
          projectId,
          runtimeConfigurationId,
          primary.id,
        ),
      )
      .toMatchObject({ state: "running" });

    reconcileRuntime = () =>
      runConfigurationRuntimeWorkerReconciliationSchema.parse({
        runtimes: [],
        orphanedRuntimeIds: [],
      });
    const beforeReconnect = commands.length;
    const reconnect = await app.injectWS(
      `/api/internal/workers/connect?workerId=${workerId}`,
      { headers: { authorization: `Bearer ${config.workerToken}` } },
    );
    await expect
      .poll(() =>
        commands
          .slice(beforeReconnect)
          .find(
            (command) =>
              command.type === "project.run-configuration-runtime.reconcile",
          ),
      )
      .toMatchObject({
        identities: [
          expect.objectContaining({
            runtimeId: requested.runtime.id,
            generation: 1,
          }),
        ],
      });
    await expect
      .poll(() =>
        database.repository.getRunConfigurationRuntime(
          LOCAL_USER_ID,
          projectId,
          runtimeConfigurationId,
          primary.id,
        ),
      )
      .toMatchObject({
        state: "lost",
        failure: { phase: "reconcile", code: "process-missing" },
      });
    reconnect.terminate();

    const orphanedRuntimeId = randomUUID();
    reconcileRuntime = (identities) =>
      runConfigurationRuntimeWorkerReconciliationSchema.parse({
        runtimes: identities.map((identity) => ({ found: false, identity })),
        orphanedRuntimeIds: [orphanedRuntimeId],
      });
    const beforeEmptyReconnect = commands.length;
    const emptyReconnect = await app.injectWS(
      `/api/internal/workers/connect?workerId=${workerId}`,
      { headers: { authorization: `Bearer ${config.workerToken}` } },
    );
    await expect
      .poll(() =>
        commands
          .slice(beforeEmptyReconnect)
          .find(
            (command) =>
              command.type === "project.run-configuration-runtime.reconcile",
          ),
      )
      .toMatchObject({ identities: [] });
    emptyReconnect.terminate();
  });

  it("stops and retires active Run instances before unlinking a project", async () => {
    const worktrees = await database.repository.listProjectWorktrees(
      LOCAL_USER_ID,
      projectId,
    );
    const primary = worktrees.find(({ isPrimary }) => isPrimary);
    if (!primary) throw new Error("Expected a Primary worktree.");
    const activeRuntimes = [];
    for (const worktree of [primary, primary]) {
      const requested =
        await database.repository.requestRunConfigurationRuntimeOperation(
          LOCAL_USER_ID,
          {
            operation: "start",
            operationId: randomUUID(),
            projectId,
            configurationId: randomUUID(),
            worktreeId: worktree.id,
            workerId,
            definitionRevision: "e".repeat(64),
            codexEnvironmentRevision: null,
          },
        );
      if (!requested.runtime) throw new Error("Expected an active runtime.");
      await database.repository.applyRunConfigurationRuntimeObservation(
        LOCAL_USER_ID,
        workerId,
        runtimeObservation(requested.runtime, "running"),
      );
      activeRuntimes.push(requested.runtime);
    }

    connected = false;
    const commandsBeforeOfflineDelete = commands.length;
    const offlineDelete = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      payload: { deleteLocalFiles: false },
    });
    expect(offlineDelete.statusCode).toBe(503);
    expect(commands).toHaveLength(commandsBeforeOfflineDelete);
    expect(
      await database.repository.getProject(LOCAL_USER_ID, projectId),
    ).not.toBeNull();

    connected = true;
    const commandsBeforeDelete = commands.length;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      payload: { deleteLocalFiles: false },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const removalCommands = commands.slice(commandsBeforeDelete);
    const stoppedRuntimeIds = removalCommands.flatMap((command) =>
      command.type === "project.run-configuration-runtime.stop"
        ? [command.identity.runtimeId]
        : [],
    );
    expect(new Set(stoppedRuntimeIds)).toEqual(
      new Set(activeRuntimes.map(({ id }) => id)),
    );
    const firstTerminalClose = removalCommands.findIndex(
      ({ type }) => type === "terminal.close",
    );
    expect(firstTerminalClose).toBeGreaterThanOrEqual(activeRuntimes.length);
    expect(
      removalCommands.some(({ type }) => type === "project.files.delete"),
    ).toBe(false);
    expect(
      await database.repository.getProject(LOCAL_USER_ID, projectId),
    ).toBeNull();
  });
});
