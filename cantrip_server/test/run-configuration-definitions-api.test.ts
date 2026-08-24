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
  unavailableCodeCapabilities,
  unprobedCodexRuntimeReport,
  type AppLiveServerMessage,
  type WorkerCommand,
  type WorkerHeartbeat,
  type WorkerNotification,
} from "@cantrip/protocol";
import {
  runConfigurationDeleteResponseSchema,
  runConfigurationGetResponseSchema,
  runConfigurationListResponseSchema,
  runConfigurationWriteResponseSchema,
} from "@cantrip/protocol/run-configuration-operations";
import {
  runConfigurationRuntimeWorkerObservationSchema,
  runConfigurationRuntimeWorkerReconciliationSchema,
  type RunConfigurationRuntime,
  type RunConfigurationRuntimeWorkerIdentity,
} from "@cantrip/protocol/run-configuration-runtime";
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
let reconcileRuntime = (identities: RunConfigurationRuntimeWorkerIdentity[]) =>
  runConfigurationRuntimeWorkerReconciliationSchema.parse({
    runtimes: identities.map((identity) => ({ found: false, identity })),
    orphanedRuntimeIds: [],
  });

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
    switch (command.type) {
      case "project.run-configuration-definitions.list":
      case "project.run-configuration-definitions.get":
      case "project.run-configuration-definitions.capabilities":
      case "project.run-configuration-definitions.write":
      case "project.run-configuration-definitions.delete":
        return definitionService.execute(command);
      case "project.run-configuration-runtime.reconcile":
        return reconcileRuntime(command.identities);
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
  ]);
});

describe.sequential("Run configuration definition API", () => {
  it("performs Primary-backed CRUD with exact revisions and Shell capabilities", async () => {
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
      capabilities: [{ provider: "shell", available: true }],
    });

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
});
