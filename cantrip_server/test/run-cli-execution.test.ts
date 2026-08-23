import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cantripCliCommandResultSchema,
  protectedRunConfigurationAuthoringSnapshotSchema,
  protectedRunConfigurationInspectionSchema,
  protectedRunConfigurationWriteResultSchema,
  protectedRunLogResultSchema,
  unprobedCodexRuntimeReport,
  type EndpointContentOpaque,
  type WorkerCommand,
  type WorkerRunSnapshot,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import { protectedProjectFields } from "./private-label-fixture.js";

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

const routedCommands: WorkerCommand[] = [];
const runs = new Map<string, WorkerRunSnapshot>();
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

async function cli(
  command:
    | "run.list"
    | "run.show"
    | "run.start"
    | "run.status"
    | "run.logs"
    | "run.stop",
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

beforeAll(async () => {
  await mkdir(projectPath, { recursive: true });
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
      operations: expect.arrayContaining(["context.get", "policy.read"]),
    });
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

  it("returns protected configuration to raw CLI adapters", async () => {
    const listed = await cli("run.list", {}, "run-list-protected");
    expect(listed.statusCode, listed.body).toBe(200);
    const result = cantripCliCommandResultSchema.parse(listed.json());
    expect(
      protectedRunConfigurationInspectionSchema.parse(result.data),
    ).toMatchObject({
      projectId,
      worktreeId,
      protectedInspection: opaque,
    });

    const shown = await cli(
      "run.show",
      { action: "server-must-not-select-this" },
      "run-show-protected",
    );
    expect(shown.statusCode, shown.body).toBe(200);
    expect(
      protectedRunConfigurationInspectionSchema.parse(
        cantripCliCommandResultSchema.parse(shown.json()).data,
      ),
    ).toMatchObject({ projectId, worktreeId });
  });

  it("keeps Run lifecycle public while relaying log content opaquely", async () => {
    const requestId = crypto.randomUUID();
    const started = await cli(
      "run.start",
      { actionId, configRevision: configurationRevision, focus: false },
      requestId,
    );
    expect(started.statusCode, started.body).toBe(200);
    const run = (
      cantripCliCommandResultSchema.parse(started.json()).data as {
        run: { id: string };
      }
    ).run;

    const logs = await cli(
      "run.logs",
      { runId: run.id, tail: 20_000 },
      "run-logs-protected",
    );
    expect(logs.statusCode, logs.body).toBe(200);
    expect(
      protectedRunLogResultSchema.parse(
        cantripCliCommandResultSchema.parse(logs.json()).data,
      ),
    ).toMatchObject({
      projectId,
      worktreeId,
      protectedLog: opaque,
      run: { id: run.id, state: "running" },
    });

    const stopped = await cli(
      "run.stop",
      { runId: run.id },
      "run-stop-protected",
    );
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(stopped.json()).data,
    ).toMatchObject({ run: { id: run.id, state: "stopped" } });
  });
});
