import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chatImportJobListSchema,
  chatImportJobSummarySchema,
  chatMessageListSchema,
  chatListSchema,
  externalChatDiscoveryWorkerResultSchema,
  externalChatReadWorkerResultSchema,
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
    if (command.type === "external.chat-history.read") {
      const target = command.targets[0]!;
      return externalChatReadWorkerResultSchema.parse({
        transcript: {
          sourceId: command.sourceId,
          sourceThreadId: command.sourceThreadId,
          metadata: {
            sourceThreadId: command.sourceThreadId,
            title: "Import this chat",
            preview: "Continue building the importer",
            cwd: target.path,
            createdAt: "2026-08-14T10:00:00.000Z",
            updatedAt: "2026-08-15T10:00:00.000Z",
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
          sync: {
            threadId: command.sourceThreadId,
            status: "idle",
            turns: [
              {
                id: "turn-one",
                status: "completed",
                startedAt: 1_786_800_000,
                completedAt: 1_786_800_010,
                durationMs: 10_000,
                items: [
                  {
                    type: "userMessage",
                    id: "user-one",
                    text: "Please continue this work.",
                  },
                  {
                    type: "agentMessage",
                    id: "agent-one",
                    text: "The canonical transcript is ready.",
                    phase: "final_answer",
                    correlation: {
                      diagnosticId: null,
                      threadId: command.sourceThreadId,
                      turnId: "turn-one",
                      itemId: "agent-one",
                      sourceMethod: "thread/read",
                    },
                  },
                ],
              },
            ],
          },
        },
      });
    }
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
let primaryWorktreeId: string;

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
  primaryWorktreeId = (
    await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
  ).find((worktree) => worktree.workerId === "local-worker")!.id;
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

  it("durably imports a source transcript exactly once", async () => {
    requests.length = 0;
    const create = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat-imports`,
      payload: {
        imports: [
          {
            sourceKind: "chatgpt-codex",
            sourceWorkerId: "local-worker",
            sourceId: "a".repeat(64),
            sourceThreadId: "source-thread-one",
            idempotencyKey: "import-source-thread-one",
            target: {
              kind: "worktree",
              projectId,
              worktreeId: primaryWorktreeId,
            },
          },
        ],
      },
    });

    expect(create.statusCode).toBe(202);
    const [created] = chatImportJobListSchema.parse(create.json());
    expect(created).toMatchObject({ state: "queued", chatId: null });

    let job = created!;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/chat-imports/${created!.id}`,
      });
      job = chatImportJobSummarySchema.parse(response.json());
      if (job.state === "awaiting-hydration") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(job).toMatchObject({
      state: "awaiting-hydration",
      chatId: expect.any(String),
      sourceMetadata: { title: "Import this chat" },
    });
    expect(
      requests.filter(
        ({ command }) => command.type === "external.chat-history.read",
      ),
    ).toHaveLength(1);

    const chats = chatListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/chats`,
        })
      ).json(),
    );
    expect(chats.find(({ id }) => id === job.chatId)).toMatchObject({
      title: "Import this chat",
      status: "idle",
    });
    const messages = chatMessageListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${job.chatId}/messages`,
        })
      ).json(),
    );
    expect(messages).toHaveLength(2);
    expect(messages.map(({ role }) => role)).toEqual(["user", "assistant"]);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat-imports`,
      payload: {
        imports: [
          {
            sourceKind: "chatgpt-codex",
            sourceWorkerId: "local-worker",
            sourceId: "a".repeat(64),
            sourceThreadId: "source-thread-one",
            idempotencyKey: "import-source-thread-one",
            target: {
              kind: "worktree",
              projectId,
              worktreeId: primaryWorktreeId,
            },
          },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(202);
    expect(chatImportJobListSchema.parse(duplicate.json())[0]?.id).toBe(job.id);
    expect(
      requests.filter(
        ({ command }) => command.type === "external.chat-history.read",
      ),
    ).toHaveLength(1);
  });

  it("blocks while the source worker is offline and resumes on retry", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat-imports`,
      payload: {
        imports: [
          {
            sourceKind: "chatgpt-codex",
            sourceWorkerId: "offline-worker",
            sourceId: "b".repeat(64),
            sourceThreadId: "source-thread-offline",
            idempotencyKey: "import-source-thread-offline",
            target: {
              kind: "worktree",
              projectId,
              worktreeId: primaryWorktreeId,
            },
          },
        ],
      },
    });
    expect(create.statusCode).toBe(202);
    const [created] = chatImportJobListSchema.parse(create.json());

    let job = created!;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = chatImportJobSummarySchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/chat-imports/${created!.id}`,
          })
        ).json(),
      );
      if (job.state === "blocked") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job).toMatchObject({
      state: "blocked",
      error: { code: "worker-offline", retryable: true },
    });

    connectedWorkers.add("offline-worker");
    try {
      const retry = await app.inject({
        method: "POST",
        url: `/api/chat-imports/${job.id}/retry`,
        payload: { stateRevision: job.stateRevision },
      });
      expect(retry.statusCode).toBe(200);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        job = chatImportJobSummarySchema.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/chat-imports/${created!.id}`,
            })
          ).json(),
        );
        if (job.state === "awaiting-hydration") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(job).toMatchObject({
        state: "awaiting-hydration",
        chatId: expect.any(String),
        error: null,
      });
    } finally {
      connectedWorkers.delete("offline-worker");
    }
  });
});
