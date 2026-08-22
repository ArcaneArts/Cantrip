import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CANTRIP_MCP_OPERATIONS,
  cantripAgentOperationResultSchema,
  cantripCliCommandResultSchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
  type WorkerRunSnapshot,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

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
const routedCommands: WorkerCommand[] = [];
const routedWorkers: string[] = [];
const runs = new Map<string, WorkerRunSnapshot>();
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return workerId === "run-worker" || workerId === "run-worker-beta";
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
  async request(workerId, command) {
    routedWorkers.push(workerId);
    routedCommands.push(command);
    switch (command.type) {
      case "project.run-configurations.inspect":
        expect(workerId).toBe("run-worker");
        return {
          platform: "linux",
          canonical: {
            relativePath: ".codex/environments/environment.toml",
            sourceControlState: "ignored",
          },
          configured: true,
          valid: true,
          configurations: [
            {
              relativePath: ".codex/environments/environment.toml",
              revision: configurationRevision,
              version: 1,
              name: "Spectral Lab",
              sourceControlState: "ignored",
              setup: null,
              actions: [
                {
                  id: actionId,
                  name: "Run Spectral Lab",
                  icon: "run",
                  command: "dotnet run --project ./src/SpectralLab.App",
                  platform: "linux",
                  configurationPath: ".codex/environments/environment.toml",
                  sourceIndex: 1,
                },
              ],
              diagnostics: [],
            },
          ],
          diagnostics: [],
        };
      case "project.run.start": {
        expect(workerId).toBe("run-worker");
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
        return { run, data: "Spectral Lab ready\n", truncated: false };
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
      default:
        throw new Error(`Unexpected Run CLI worker command ${command.type}.`);
    }
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let worktreeId: string;

async function cli(
  command: "run.start" | "run.status" | "run.logs" | "run.stop",
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
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "run-worker-beta",
    name: "Run Worker Beta",
    platform: "win32",
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
    {
      workerId: "run-worker",
      ...protectedProjectFields(),
    },
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
  expect(created.project.id).toBe(claimed.job.projectId);
  projectId = created.project.id;
  const worktrees = await database.repository.listProjectWorktrees(
    LOCAL_USER_ID,
    projectId,
  );
  worktreeId = worktrees[0]!.id;
  app = await buildApp({ config, database, logger: false, workerBridge });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("Run CLI execution", () => {
  it("starts headlessly, retries idempotently, reads status/logs, and stops", async () => {
    const requestId = "run-start-idempotency-fixture";
    const start = await cli(
      "run.start",
      { action: "Run Spectral Lab", focus: false },
      requestId,
    );
    expect(start.statusCode, start.body).toBe(200);
    const started = cantripCliCommandResultSchema.parse(start.json());
    expect(started.data).toMatchObject({
      run: {
        actionId,
        configurationRevision,
        state: "running",
        terminalId: null,
      },
    });
    const runId = (started.data as { run: { id: string } }).run.id;

    const retry = await cli(
      "run.start",
      { action: actionId, focus: false },
      requestId,
    );
    expect(retry.statusCode, retry.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(retry.json()).data,
    ).toMatchObject({
      run: { id: runId, state: "running" },
    });
    const starts = routedCommands.filter(
      (command) => command.type === "project.run.start",
    );
    expect(starts).toHaveLength(2);
    expect(starts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId,
          requestId,
          actionId,
          configurationRevision,
          sourcePath: projectPath,
          worktreePath: projectPath,
        }),
      ]),
    );
    expect(starts.some((command) => "command" in command)).toBe(false);

    const status = await cli("run.status", {}, "run-status-fixture");
    expect(status.statusCode, status.body).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(status.json()).data,
    ).toMatchObject({
      run: { id: runId, state: "running" },
    });

    const logs = await cli(
      "run.logs",
      { runId, tail: 1000 },
      "run-logs-fixture",
    );
    expect(logs.statusCode, logs.body).toBe(200);
    expect(cantripCliCommandResultSchema.parse(logs.json()).data).toMatchObject(
      {
        run: { id: runId },
        data: "Spectral Lab ready\n",
        truncated: false,
      },
    );

    const stop = await cli("run.stop", { runId }, "run-stop-fixture");
    expect(stop.statusCode, stop.body).toBe(200);
    expect(cantripCliCommandResultSchema.parse(stop.json()).data).toMatchObject(
      {
        run: { id: runId, state: "stopped", signal: "SIGTERM" },
      },
    );

    const audits = await database.repository.listAuditEvents(
      { limit: 50 },
      LOCAL_USER_ID,
    );
    expect(audits.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "run.cli.started",
          result: "succeeded",
          resource: { type: "run-instance", id: runId },
        }),
        expect.objectContaining({
          action: "run.cli.stopped",
          result: "succeeded",
          resource: { type: "run-instance", id: runId },
        }),
      ]),
    );
  });

  it("revalidates MCP revisions, routes Run state cross-worker, and audits mutations", async () => {
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        ...protectedChatFields(),
        worktreeId,
        worktreeMode: "pinned",
      },
    );
    if (!chat) throw new Error("Expected an MCP Run test chat.");
    const context = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat.id,
      "agent",
      "Exercise managed Run MCP operations",
    );
    if (!context?.executionLaneId) {
      throw new Error("Expected an active MCP Run execution lane.");
    }
    const bindingId = "00000000-0000-4000-8000-000000000399";
    const binding = {
      bindingId,
      ownerId: LOCAL_USER_ID,
      projectId,
      chatId: chat.id,
      executionLaneId: context.executionLaneId,
      workerId: context.workerId,
      worktreeId: context.worktreeId,
      canonicalRoot: context.cwd,
      rootKind: context.rootKind,
      permissionProfileId:
        context.permissionProfileId ??
        context.defaultPermissionProfileId ??
        ":workspace-write",
      allowedOperations: [...CANTRIP_MCP_OPERATIONS],
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const mcp = (
      operation: "run-config.read" | "run.status" | "run.stop",
      arguments_: Record<string, unknown>,
      requestId: string,
    ) =>
      app.inject({
        method: "POST",
        url: "/api/internal/agent-operations",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {
          requestId,
          binding,
          request: { operation, arguments: arguments_ },
        },
      });

    const stale = await mcp(
      "run-config.read",
      { actionId, configRevision: "c".repeat(64) },
      "mcp-run-stale",
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ code: "conflict" });

    const durable = await database.repository.createOrGetRunInstance(
      LOCAL_USER_ID,
      {
        projectId,
        worktreeId,
        workerId: "run-worker-beta",
        idempotencyKey: "mcp-cross-worker-run",
        actionId,
        configurationRevision,
      },
    );
    runs.set(durable.run.id, {
      runId: durable.run.id,
      projectId,
      worktreeId,
      actionId,
      configurationRevision,
      state: "running",
      startedAt: "2026-08-21T12:10:00.000Z",
      endedAt: null,
      exitCode: null,
      signal: null,
    });

    const status = await mcp(
      "run.status",
      { runId: durable.run.id },
      "mcp-run-status",
    );
    expect(status.statusCode, status.body).toBe(200);
    expect(
      cantripAgentOperationResultSchema.parse(status.json()).data,
    ).toMatchObject({
      run: {
        id: durable.run.id,
        workerId: "run-worker-beta",
        state: "running",
      },
    });
    expect(routedWorkers.at(-1)).toBe("run-worker-beta");

    const stopped = await mcp(
      "run.stop",
      { runId: durable.run.id },
      "mcp-run-stop",
    );
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(
      cantripAgentOperationResultSchema.parse(stopped.json()).data,
    ).toMatchObject({ run: { id: durable.run.id, state: "stopped" } });
    expect(routedWorkers.at(-1)).toBe("run-worker-beta");

    const audits = await database.repository.listAuditEvents(
      { limit: 50 },
      LOCAL_USER_ID,
    );
    expect(audits.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "run.mcp.stopped",
          result: "succeeded",
          resource: { type: "run-instance", id: durable.run.id },
        }),
      ]),
    );
    expect(JSON.stringify(audits.items)).not.toContain("dotnet run --project");
  });
});
