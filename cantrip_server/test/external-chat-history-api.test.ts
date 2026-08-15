import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  externalChatDiscoveryWorkerResultSchema,
  projectExternalChatDiscoverySchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-external-chat-history-api-"),
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

const connectedWorkers = new Set(["local-worker"]);
const requests: Array<{ workerId: string; command: WorkerCommand }> = [];
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
  async request(workerId, command) {
    requests.push({ workerId, command });
    if (command.type !== "external.chat-history.discover") {
      throw new Error(`Unexpected worker command ${command.type}.`);
    }
    const target = command.targets[0]!;
    return externalChatDiscoveryWorkerResultSchema.parse({
      sources: [
        {
          kind: "chatgpt-codex",
          sourceId: "a".repeat(64),
          name: "ChatGPT Codex",
          platform: "darwin",
          homeLabel: "~/.codex",
          availability: "available",
          message: null,
          runtimeVersion: "0.147.0",
          truncated: false,
          threads: [
            {
              sourceThreadId: "source-thread-one",
              title: "Import this chat",
              preview: "Continue building the importer",
              cwd: target.path,
              createdAt: "2026-08-14T10:00:00.000Z",
              updatedAt: "2026-08-15T10:00:00.000Z",
              archived: command.includeArchived,
              source: "vscode",
              status: "not-loaded",
              modelProvider: "openai",
              cliVersion: "0.147.0",
              git: null,
              match: {
                kind: "worktree-path",
                projectReplicaId: target.projectReplicaId,
                worktreeId: target.worktrees[0]?.worktreeId ?? null,
              },
            },
          ],
        },
      ],
      truncated: false,
    });
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;

async function recordWorker(
  workerId: string,
  name: string,
  externalCodexHistory: boolean,
) {
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId,
    name,
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.147.0",
    codexRuntime: unprobedCodexRuntimeReport,
    externalCodexHistory,
    startedAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  database = await connectDatabase(config);
  await recordWorker("local-worker", "Local Worker", true);
  await recordWorker("offline-worker", "Offline Worker", true);
  await recordWorker("legacy-worker", "Legacy Worker", false);
  await recordWorker("unrelated-worker", "Unrelated Worker", true);
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "local-worker",
    repositoryId: "external-chat-history-api",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  for (const workerId of ["local-worker", "offline-worker", "legacy-worker"]) {
    await database.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      projectId,
      workerId,
      {
        path: path.join(dataDirectory, workerId, "Cantrip"),
        displayPath: path.join(dataDirectory, workerId, "Cantrip"),
        reused: false,
        updated: false,
        warning: null,
      },
    );
  }
  app = await buildApp({ config, database, logger: false, workerBridge });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("external Codex chat history discovery API", () => {
  it("fans metadata discovery only to capable project workers", async () => {
    requests.length = 0;
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/external-chat-history?includeArchived=true`,
    });

    expect(response.statusCode).toBe(200);
    const result = projectExternalChatDiscoverySchema.parse(response.json());
    expect(result).toMatchObject({
      projectId,
      partial: true,
      truncated: false,
    });
    expect(result.workers).toHaveLength(3);
    expect(
      result.workers.find(({ workerId }) => workerId === "local-worker"),
    ).toMatchObject({
      status: "ok",
      sources: [
        {
          availability: "available",
          threads: [{ archived: true }],
        },
      ],
    });
    expect(
      result.workers.find(({ workerId }) => workerId === "offline-worker"),
    ).toMatchObject({
      status: "offline",
      sources: [],
      error: { code: "worker-offline" },
    });
    expect(
      result.workers.find(({ workerId }) => workerId === "legacy-worker"),
    ).toMatchObject({
      status: "unsupported",
      sources: [],
      error: { code: "capability-missing" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      workerId: "local-worker",
      command: {
        type: "external.chat-history.discover",
        includeArchived: true,
        targets: [
          {
            worktrees: [{ isPrimary: true }],
          },
        ],
      },
    });
  });

  it("rejects invalid filters and unknown projects", async () => {
    const invalid = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/external-chat-history?includeArchived=yes`,
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-4000-8000-000000000000/external-chat-history",
    });

    expect(invalid.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
  });
});
