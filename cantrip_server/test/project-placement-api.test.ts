import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  browserSummarySchema,
  executionPlacementResolutionSchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import {
  ExecutionPlacementUnavailableError,
  LOCAL_USER_ID,
} from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-placement-api-"),
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
  workerToken: "test-worker-token",
};

const connectedWorkers = new Set(["worker-alpha", "worker-beta"]);
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return connectedWorkers.has(workerId);
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
  async request() {
    throw new Error("Placement tests do not send worker commands.");
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let alphaWorktreeId: string;
let betaWorktreeId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "worker-alpha",
    name: "Alpha",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    code: {
      available: true,
      version: "1.109.5",
      upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
      patchset: 1,
      transport: "web-proxy",
      maxSessions: 4,
      reason: null,
    },
    remoteSurfaces: {
      browser: true,
      desktop: true,
      transports: ["websocket"],
      maxSessions: 4,
    },
    startedAt: new Date().toISOString(),
  });
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "worker-beta",
    name: "Beta",
    platform: "linux",
    architecture: "x64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "worker-alpha",
    repositoryId: "placement-api",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  for (const workerId of ["worker-alpha", "worker-beta"]) {
    await database.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      projectId,
      workerId,
      {
        path: path.join(dataDirectory, workerId),
        displayPath: `ArcaneArts/Cantrip (${workerId})`,
        reused: false,
        updated: false,
        warning: null,
      },
    );
  }
  const worktrees = await database.repository.listProjectWorktrees(
    LOCAL_USER_ID,
    projectId,
  );
  alphaWorktreeId = worktrees.find(
    ({ workerId }) => workerId === "worker-alpha",
  )!.id;
  betaWorktreeId = worktrees.find(
    ({ workerId }) => workerId === "worker-beta",
  )!.id;
  app = await buildApp({ config, database, logger: false, workerBridge });
});

beforeEach(async () => {
  connectedWorkers.clear();
  connectedWorkers.add("worker-alpha");
  connectedWorkers.add("worker-beta");
  await database.repository.updateSettings(LOCAL_USER_ID, {
    defaultWorkerId: "worker-alpha",
  });
  await database.repository.updateProjectPreferredWorker(
    LOCAL_USER_ID,
    projectId,
    "worker-beta",
  );
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("project execution placement API", () => {
  it("uses project preference, global default, then a stable compatible fallback", async () => {
    const terminal = await database.repository.resolveProjectExecutionPlacement(
      LOCAL_USER_ID,
      projectId,
      "terminal",
      undefined,
      workerBridge.isConnected.bind(workerBridge),
    );
    expect(terminal).toMatchObject({
      selection: "project-preference",
      placement: {
        workerId: "worker-beta",
        worktreeId: betaWorktreeId,
      },
    });

    const code = await database.repository.resolveProjectExecutionPlacement(
      LOCAL_USER_ID,
      projectId,
      "code",
      undefined,
      workerBridge.isConnected.bind(workerBridge),
    );
    expect(code).toMatchObject({
      selection: "default-worker",
      placement: {
        workerId: "worker-alpha",
        worktreeId: alphaWorktreeId,
      },
    });

    await database.repository.updateSettings(LOCAL_USER_ID, {
      defaultWorkerId: null,
    });
    await database.repository.updateProjectPreferredWorker(
      LOCAL_USER_ID,
      projectId,
      null,
    );
    expect(
      await database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "explorer",
        undefined,
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).toMatchObject({
      selection: "fallback",
      placement: { workerId: "worker-alpha" },
    });
  });

  it("honors explicit worktrees and never silently moves an invalid target", async () => {
    expect(
      await database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "terminal",
        { kind: "worktree", projectId, worktreeId: alphaWorktreeId },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).toMatchObject({
      selection: "explicit",
      placement: {
        workerId: "worker-alpha",
        worktreeId: alphaWorktreeId,
      },
    });

    connectedWorkers.delete("worker-beta");
    await expect(
      database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "terminal",
        { kind: "worker", projectId, workerId: "worker-beta" },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).rejects.toMatchObject<Partial<ExecutionPlacementUnavailableError>>({
      code: "worker-offline",
    });
    await expect(
      database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "browser",
        { kind: "worker", projectId, workerId: "worker-beta" },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).rejects.toMatchObject<Partial<ExecutionPlacementUnavailableError>>({
      code: "worker-offline",
    });
  });

  it("exposes structured resolution failures and persists surface ownership", async () => {
    const resolved = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/placement/resolve`,
      payload: {
        surfaceKind: "terminal",
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(
      executionPlacementResolutionSchema.parse(resolved.json()),
    ).toMatchObject({
      selection: "explicit",
      placement: { workerId: "worker-alpha" },
    });

    connectedWorkers.delete("worker-beta");
    const unavailable = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/placement/resolve`,
      payload: {
        surfaceKind: "terminal",
        target: { kind: "worker", projectId, workerId: "worker-beta" },
      },
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({ code: "worker-offline" });
    connectedWorkers.add("worker-beta");

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        title: "Placed browser",
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(browserSummarySchema.parse(created.json())).toMatchObject({
      workerId: "worker-alpha",
    });
  });
});
