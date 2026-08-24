import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CANTRIP_MCP_OPERATIONS,
  cantripCliCommandResultSchema,
  protectedRunConfigurationAuthoringSnapshotSchema,
  protectedRunConfigurationWriteResultSchema,
  unprobedCodexRuntimeReport,
  type EndpointContentOpaque,
  type CantripMcpBinding,
  type WorkerCommand,
  type WorkerRunSnapshot,
} from "@cantrip/protocol";
import {
  protectedRunConfigurationRuntimeOutputResultSchema,
  runConfigurationRuntimeOperationResultSchema,
  runConfigurationRuntimeStatusResultSchema,
  runConfigurationRuntimeWorkerOperationResultSchema,
} from "@cantrip/protocol/run-configuration-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import { RunConfigurationDefinitionService } from "../../cantrip_worker/src/run-configuration-definition-service.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(path.join(tmpdir(), "cantrip-run-cli-"));
const projectPath = path.join(dataDirectory, "project");
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
  workerToken: "test-worker-token",
};

const actionId = "a".repeat(64);
const configurationRevision = "b".repeat(64);
const configurationId = "0f82c573-704d-4a06-984e-5ce0b8d688ca";
const opaque: EndpointContentOpaque = {
  formatVersion: 1,
  domain: "run-content",
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};
const protectedSecretValue = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

const routedCommands: WorkerCommand[] = [];
const runs = new Map<string, WorkerRunSnapshot>();
const definitionService = new RunConfigurationDefinitionService({
  emit: () => undefined,
});
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected() {
    return true;
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(_workerId, command) {
    routedCommands.push(command);
    switch (command.type) {
      case "project.run-configuration-definitions.list":
      case "project.run-configuration-definitions.get":
      case "project.run-configuration-definitions.capabilities":
      case "project.run-configuration-definitions.detect":
      case "project.run-configuration-definitions.write":
      case "project.run-configuration-definitions.delete":
        return definitionService.execute(command);
      case "project.run-configuration-runtime.start":
      case "project.run-configuration-runtime.restart":
        return runConfigurationRuntimeWorkerOperationResultSchema.parse({
          outcome: "accepted",
          observation: {
            ...command.identity,
            state: "running",
            startedAt: "2026-08-21T12:00:00.000Z",
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
            startedAt: "2026-08-21T12:00:00.000Z",
            endedAt: "2026-08-21T12:00:02.000Z",
            exitCode: null,
            signal: "SIGTERM",
            failure: null,
          },
        });
      case "project.run-configuration-runtime.output":
        return {
          requestOperationId: command.requestOperationId,
          identity: command.identity,
          protectedOutput: opaque,
        };
      case "project.run-configuration-runtime.reconcile":
        return { runtimes: [], orphanedRuntimeIds: [] };
      case "project.run-configurations.inspect":
        return {
          operationId: command.operationId,
          projectId: command.projectId,
          worktreeId: command.worktreeId,
          metadata: {
            platform: "linux",
            configured: true,
            valid: true,
            hasSetup: false,
            configurationRevision,
          },
          protectedInspection: opaque,
        };
      case "project.run-configurations.read-authoring":
        return {
          operationId: command.operationId,
          projectId: command.projectId,
          worktreeId: command.worktreeId,
          protectedSnapshot: opaque,
        };
      case "project.run-configurations.write":
        return opaque;
      case "project.run.start": {
        const existing = runs.get(command.runId);
        if (existing) return existing;
        const started: WorkerRunSnapshot = {
          runId: command.runId,
          projectId: command.projectId,
          worktreeId: command.worktreeId,
          actionId: command.actionId,
          configurationRevision: command.configurationRevision,
          state: "running",
          startedAt: "2026-08-21T12:00:00.000Z",
          endedAt: null,
          exitCode: null,
          signal: null,
        };
        runs.set(command.runId, started);
        return started;
      }
      case "project.run.status": {
        const run = runs.get(command.runId);
        return run
          ? { found: true, run }
          : { found: false, runId: command.runId };
      }
      case "project.run.logs": {
        const run = runs.get(command.runId);
        if (!run) throw new Error("Run missing from test worker.");
        return {
          operationId: command.operationId,
          projectId: command.projectId,
          worktreeId: command.worktreeId,
          run,
          protectedLog: opaque,
        };
      }
      case "project.run.stop": {
        const current = runs.get(command.runId);
        if (!current) return { found: false, runId: command.runId };
        const stopped: WorkerRunSnapshot = {
          ...current,
          state: "stopped",
          endedAt: "2026-08-21T12:00:02.000Z",
          signal: "SIGTERM",
        };
        runs.set(command.runId, stopped);
        return { found: true, run: stopped };
      }
      case "project.run.reconcile":
        return command.runs.map((identity) => {
          const run = runs.get(identity.runId);
          return run
            ? { found: true as const, run }
            : { found: false as const, runId: identity.runId };
        });
      default:
        throw new Error(`Unexpected Run worker command ${command.type}.`);
    }
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let worktreeId: string;
let mcpBinding: CantripMcpBinding;

async function cli(
  command:
    | "run.list"
    | "run.show"
    | "run.detect"
    | "run.create"
    | "run.update"
    | "run.delete"
    | "run.start"
    | "run.restart"
    | "run.status"
    | "run.logs"
    | "run.stop"
    | "run.secret-set",
  arguments_: Record<string, unknown>,
  requestId: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/internal/cli",
    headers: { authorization: `Bearer ${config.workerToken}` },
    payload: {
      command,
      chatContext: null,
      context: {
        codexThreadId: null,
        terminalId: null,
        cwd: projectPath,
      },
      arguments: arguments_,
      requestId,
      workerId: "run-worker",
    },
  });
}

async function mcp(
  operation: CantripMcpBinding["allowedOperations"][number],
  arguments_: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/api/internal/agent-operations",
    headers: { authorization: `Bearer ${config.workerToken}` },
    payload: {
      requestId: crypto.randomUUID(),
      binding: mcpBinding,
      request: { operation, arguments: arguments_ },
    },
  });
}

beforeAll(async () => {
  await mkdir(projectPath, { recursive: true });
  await mkdir(path.join(projectPath, ".cantrip", "run-configurations"), {
    recursive: true,
  });
  await writeFile(
    path.join(
      projectPath,
      ".cantrip",
      "run-configurations",
      `${configurationId}.json`,
    ),
    `${JSON.stringify({
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Run app",
      provider: "shell",
      target: { kind: "command", command: "pnpm dev" },
    })}\n`,
  );
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "run-worker",
    name: "Run Worker",
    platform: "linux",
    architecture: "x64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    managedFolders: {
      create: true,
      attachExisting: true,
      convertToGithub: true,
      remove: true,
    },
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const created = await database.repository.createManagedFolderProject(
    LOCAL_USER_ID,
    { workerId: "run-worker", ...protectedProjectFields() },
  );
  const claimed = await database.repository.projectFolderSetupJobs.claimNext();
  if (!claimed) throw new Error("Expected a folder setup job.");
  await database.repository.projectFolderSetupJobs.complete(
    claimed.job.id,
    claimed.commandId,
    {
      status: "ready",
      jobId: claimed.job.id,
      attempt: claimed.job.attempt,
      path: projectPath,
      displayPath: "project",
      reused: false,
    },
  );
  projectId = created.project.id;
  worktreeId = (
    await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
  )[0]!.id;
  app = await buildApp({ config, database, logger: false, workerBridge });
  const chat = await database.repository.createChat(LOCAL_USER_ID, projectId, {
    ...protectedChatFields(),
    worktreeId,
    worktreeMode: "pinned",
  });
  if (!chat) throw new Error("Expected a managed MCP test chat.");
  const execution = await database.repository.startChatExecutionLane(
    LOCAL_USER_ID,
    chat.id,
    "agent",
    "Exercise managed Run configuration MCP",
  );
  if (!execution) throw new Error("Expected a managed MCP execution lane.");
  const context = await database.repository.getChatExecutionContext(
    LOCAL_USER_ID,
    chat.id,
  );
  if (!context?.executionLaneId) {
    throw new Error("Expected an active managed MCP execution context.");
  }
  mcpBinding = {
    bindingId: crypto.randomUUID(),
    ownerId: LOCAL_USER_ID,
    projectId,
    chatId: chat.id,
    executionLaneId: context.executionLaneId,
    workerId: context.workerId,
    worktreeId: context.worktreeId,
    rootKind: context.rootKind,
    permissionProfileId:
      context.permissionProfileId ?? context.defaultPermissionProfileId,
    allowedOperations: [...CANTRIP_MCP_OPERATIONS],
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  };
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("Run protected server boundary", () => {
  it("advertises MCP relay compatibility to authenticated workers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/internal/agent-operations/capabilities?workerId=run-worker",
      headers: { authorization: `Bearer ${config.workerToken}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      bindingProtocolVersions: [1, 2],
      operations: expect.arrayContaining([
        "context.get",
        "policy.read",
        "run-configuration.create",
        "run-configuration.restart",
        "run-configuration.secret-set",
      ]),
    });
    expect(response.json().operations).not.toContain("run-config.list");
    expect(response.json().operations).not.toContain("run.start");
  });

  it("identifies malformed MCP relay envelopes as protocol failures", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/agent-operations",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      code: "incompatible-worker-protocol",
      error: expect.stringContaining("MCP relay protocol"),
    });
    expect(response.json().error).not.toBe("Invalid request body");
  });

  it("accepts a legacy MCP envelope before authoritative binding checks", async () => {
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/agent-operations",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: {
        requestId: "legacy-request",
        binding: {
          bindingId: "00000000-0000-4000-8000-000000000001",
          ownerId: LOCAL_USER_ID,
          projectId,
          chatId: "missing-chat",
          executionLaneId: "legacy-lane",
          workerId: "run-worker",
          worktreeId,
          canonicalRoot: `ctrr_${"A".repeat(43)}`,
          rootKind: "folder-root",
          permissionProfileId: ":workspace-write",
          allowedOperations: ["context.get"],
          issuedAt,
          expiresAt,
        },
        request: { operation: "context.get", arguments: {} },
      },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: "stale-binding" });
  });

  it("routes opaque configuration reads and writes without semantic fields", async () => {
    const read = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/run-environment/configuration`,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(
      protectedRunConfigurationAuthoringSnapshotSchema.parse(read.json()),
    ).toMatchObject({ projectId, worktreeId, protectedSnapshot: opaque });

    const operationId = crypto.randomUUID();
    const saved = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/run-environment/configuration`,
      payload: {
        operationId,
        projectId,
        worktreeId,
        protectedRequest: opaque,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      protectedRunConfigurationWriteResultSchema.parse(saved.json()),
    ).toMatchObject({
      operationId,
      projectId,
      worktreeId,
      protectedResponse: opaque,
    });
    const write = routedCommands.find(
      (command) => command.type === "project.run-configurations.write",
    );
    expect(write).toMatchObject({ protectedRequest: opaque });
    expect(write).not.toHaveProperty("document");
    expect(write).not.toHaveProperty("expectedRevision");
  });

  it("reads project-shared definitions by stable ID", async () => {
    const listed = await cli("run.list", {}, crypto.randomUUID());
    expect(listed.statusCode, listed.body).toBe(200);
    const result = cantripCliCommandResultSchema.parse(listed.json());
    expect(result.data).toMatchObject({
      operation: "list",
      projectId,
      inventory: {
        entries: [
          {
            id: configurationId,
            status: "ready",
            document: { id: configurationId, name: "Run app" },
          },
        ],
      },
    });

    const shown = await cli(
      "run.show",
      { configurationId },
      crypto.randomUUID(),
    );
    expect(shown.statusCode, shown.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(shown.json()).data,
    ).toMatchObject({
      operation: "get",
      projectId,
      result: { found: true, entry: { id: configurationId } },
    });
  });

  it("creates, revision-checks, updates, and deletes definitions", async () => {
    const id = "1f82c573-704d-4a06-984e-5ce0b8d688ca";
    const document = {
      schema: "cantrip.run-configuration",
      version: 1,
      id,
      name: "CLI server",
      provider: "shell",
      target: { kind: "command", command: "pnpm server" },
    };
    const created = await cli("run.create", { document }, crypto.randomUUID());
    expect(created.statusCode, created.body).toBe(200);
    const createdData = cantripCliCommandResultSchema.parse(created.json())
      .data as {
      result: { entry: { revision: string }; outcome: string };
    };
    expect(createdData.result.outcome).toBe("created");

    const stale = await cli(
      "run.update",
      {
        configurationId: id,
        revision: "c".repeat(64),
        document: { ...document, name: "CLI server updated" },
      },
      crypto.randomUUID(),
    );
    expect(stale.statusCode, stale.body).toBe(409);

    const updated = await cli(
      "run.update",
      {
        configurationId: id,
        revision: createdData.result.entry.revision,
        document: { ...document, name: "CLI server updated" },
      },
      crypto.randomUUID(),
    );
    expect(updated.statusCode, updated.body).toBe(200);
    const updatedData = cantripCliCommandResultSchema.parse(updated.json())
      .data as {
      result: { entry: { revision: string }; outcome: string };
    };
    expect(updatedData.result.outcome).toBe("updated");

    const deleted = await cli(
      "run.delete",
      {
        configurationId: id,
        revision: updatedData.result.entry.revision,
      },
      crypto.randomUUID(),
    );
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(deleted.json()).data,
    ).toMatchObject({ result: { outcome: "deleted", id } });
  });

  it("provides complete stable-ID managed MCP authoring and lifecycle parity", async () => {
    const id = "2f82c573-704d-4a06-984e-5ce0b8d688ca";
    const document = {
      schema: "cantrip.run-configuration",
      version: 1,
      id,
      name: "MCP server",
      provider: "shell",
      target: { kind: "command", command: "pnpm mcp" },
    };
    const created = await mcp("run-configuration.create", {
      operationId: crypto.randomUUID(),
      document,
    });
    expect(created.statusCode, created.body).toBe(200);
    const createdData = cantripCliCommandResultSchema.parse(created.json())
      .data as {
      result: { entry: { revision: string }; outcome: string };
    };
    expect(createdData.result.outcome).toBe("created");

    const listed = await mcp("run-configuration.list", {});
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      (
        cantripCliCommandResultSchema.parse(listed.json()).data as {
          inventory: { entries: Array<{ id: string }> };
        }
      ).inventory.entries.map(({ id: entryId }) => entryId),
    ).toContain(id);

    const detected = await mcp("run-configuration.detect", {
      provider: "shell",
    });
    expect(detected.statusCode, detected.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(detected.json()).data,
    ).toMatchObject({ operation: "detect", projectId });

    const fetched = await mcp("run-configuration.get", {
      configurationId: id,
    });
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(fetched.json()).data,
    ).toMatchObject({ result: { found: true, entry: { id } } });

    const updated = await mcp("run-configuration.update", {
      operationId: crypto.randomUUID(),
      configurationId: id,
      expectedRevision: createdData.result.entry.revision,
      document: { ...document, name: "MCP server updated" },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const updatedData = cantripCliCommandResultSchema.parse(updated.json())
      .data as {
      result: { entry: { revision: string }; outcome: string };
    };
    expect(updatedData.result.outcome).toBe("updated");

    const startOperationId = crypto.randomUUID();
    const startArguments = {
      operationId: startOperationId,
      configurationId: id,
      worktreeId: null,
    };
    const started = await mcp("run-configuration.start", startArguments);
    expect(started.statusCode, started.body).toBe(200);
    const startedRuntime = runConfigurationRuntimeOperationResultSchema.parse(
      cantripCliCommandResultSchema.parse(started.json()).data,
    ).runtime!;
    expect(startedRuntime).toMatchObject({
      configurationId: id,
      worktreeId,
      state: "running",
      generation: 1,
    });
    const replayedStart = await mcp("run-configuration.start", startArguments);
    expect(replayedStart.statusCode, replayedStart.body).toBe(200);
    expect(
      runConfigurationRuntimeOperationResultSchema.parse(
        cantripCliCommandResultSchema.parse(replayedStart.json()).data,
      ),
    ).toMatchObject({
      replayed: true,
      runtime: { id: startedRuntime.id, generation: 1 },
    });

    const restarted = await mcp("run-configuration.restart", {
      operationId: crypto.randomUUID(),
      configurationId: id,
      worktreeId,
    });
    expect(restarted.statusCode, restarted.body).toBe(200);
    expect(
      runConfigurationRuntimeOperationResultSchema.parse(
        cantripCliCommandResultSchema.parse(restarted.json()).data,
      ).runtime,
    ).toMatchObject({ id: startedRuntime.id, state: "running", generation: 2 });

    const status = await mcp("run-configuration.status", {
      configurationId: id,
      worktreeId,
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(
      runConfigurationRuntimeStatusResultSchema.parse(
        cantripCliCommandResultSchema.parse(status.json()).data,
      ).runtimes,
    ).toEqual([
      expect.objectContaining({ id: startedRuntime.id, state: "running" }),
    ]);

    const output = await mcp("run-configuration.read-output", {
      operationId: crypto.randomUUID(),
      configurationId: id,
      worktreeId,
      tail: 20_000,
    });
    expect(output.statusCode, output.body).toBe(200);
    expect(
      protectedRunConfigurationRuntimeOutputResultSchema.parse(
        cantripCliCommandResultSchema.parse(output.json()).data,
      ),
    ).toMatchObject({
      projectId,
      configurationId: id,
      worktreeId,
      generation: 2,
      protectedOutput: opaque,
    });

    const secret = await mcp("run-configuration.secret-set", {
      operationId: crypto.randomUUID(),
      reference: "project/mcp-secret",
      protectedValue: protectedSecretValue,
    });
    expect(secret.statusCode, secret.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(secret.json()).data,
    ).toMatchObject({
      projectId,
      secret: { reference: "project/mcp-secret", available: true },
    });
    expect(secret.body).not.toContain("plaintext");

    const stopped = await mcp("run-configuration.stop", {
      operationId: crypto.randomUUID(),
      configurationId: id,
      worktreeId,
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(
      runConfigurationRuntimeOperationResultSchema.parse(
        cantripCliCommandResultSchema.parse(stopped.json()).data,
      ).runtime,
    ).toMatchObject({ id: startedRuntime.id, state: "idle" });

    const deleted = await mcp("run-configuration.delete", {
      operationId: crypto.randomUUID(),
      configurationId: id,
      expectedRevision: updatedData.result.entry.revision,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(deleted.json()).data,
    ).toMatchObject({ result: { outcome: "deleted", id } });
  });

  it("uses durable lifecycle state and relays terminal output opaquely", async () => {
    const requestId = crypto.randomUUID();
    const started = await cli(
      "run.start",
      { configurationId, worktreeId: null },
      requestId,
    );
    expect(started.statusCode, started.body).toBe(200);
    const runtime = runConfigurationRuntimeOperationResultSchema.parse(
      cantripCliCommandResultSchema.parse(started.json()).data,
    ).runtime!;
    expect(runtime).toMatchObject({
      configurationId,
      worktreeId,
      state: "running",
      generation: 1,
    });

    const status = await cli(
      "run.status",
      { configurationId, worktreeId },
      crypto.randomUUID(),
    );
    expect(status.statusCode, status.body).toBe(200);
    expect(
      runConfigurationRuntimeStatusResultSchema.parse(
        cantripCliCommandResultSchema.parse(status.json()).data,
      ).runtimes,
    ).toEqual([expect.objectContaining({ id: runtime.id, state: "running" })]);

    const logs = await cli(
      "run.logs",
      { configurationId, worktreeId, tail: 20_000 },
      crypto.randomUUID(),
    );
    expect(logs.statusCode, logs.body).toBe(200);
    expect(
      protectedRunConfigurationRuntimeOutputResultSchema.parse(
        cantripCliCommandResultSchema.parse(logs.json()).data,
      ),
    ).toMatchObject({
      projectId,
      worktreeId,
      configurationId,
      generation: 1,
      protectedOutput: opaque,
    });

    const stopped = await cli(
      "run.stop",
      { configurationId, worktreeId },
      crypto.randomUUID(),
    );
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(
      runConfigurationRuntimeOperationResultSchema.parse(
        cantripCliCommandResultSchema.parse(stopped.json()).data,
      ).runtime,
    ).toMatchObject({ id: runtime.id, state: "idle" });
  });
});
