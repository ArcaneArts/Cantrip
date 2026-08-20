import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chatImportJobListSchema,
  chatImportJobSummarySchema,
  chatMessageListSchema,
  chatWireListSchema,
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
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_ROUTE_ID,
  LOCAL_USER_ID,
} from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

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
const hydrationDigests = new Map<string, string>();
const hydrationChunks = new Map<string, Buffer[]>();
const attachmentUploads = new Map<string, Buffer[]>();
const attachmentFiles = new Map<string, Buffer>();
const importedAttachmentBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
const importedAttachmentSha256 = createHash("sha256")
  .update(importedAttachmentBytes)
  .digest("hex");
const availableExternalAttachmentId = "1".repeat(64);
const missingExternalAttachmentId = "2".repeat(64);
let hydrationFailure: Error | null = null;
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
    if (command.type === "attachment.upload.begin") {
      attachmentUploads.set(command.attachmentId, []);
      return { accepted: true };
    }
    if (command.type === "attachment.upload.chunk") {
      attachmentUploads.get(command.attachmentId)![command.chunkIndex] =
        Buffer.from(command.data, "base64");
      return { accepted: true };
    }
    if (command.type === "attachment.upload.complete") {
      const bytes = Buffer.concat(
        attachmentUploads.get(command.attachmentId) ?? [],
      );
      attachmentUploads.delete(command.attachmentId);
      attachmentFiles.set(command.attachmentId, bytes);
      return {
        path: `/managed/${command.chatId}/${command.attachmentId}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
      };
    }
    if (command.type === "attachment.delete") {
      attachmentUploads.delete(command.attachmentId);
      attachmentFiles.delete(command.attachmentId);
      return { accepted: true };
    }
    if (command.type === "attachment.read") {
      const content = attachmentFiles.get(command.attachmentId);
      if (!content) throw new Error("Attachment was not found.");
      const bytes = content.subarray(
        command.offset,
        command.offset + command.limit,
      );
      return {
        data: bytes.toString("base64"),
        eof: command.offset + bytes.byteLength >= content.byteLength,
        sizeBytes: content.byteLength,
      };
    }
    if (command.type === "external.chat-history.attachment.read") {
      const bytes = importedAttachmentBytes.subarray(
        command.offset,
        command.offset + command.limit,
      );
      return {
        status: "available",
        data: bytes.toString("base64"),
        eof:
          command.offset + bytes.byteLength >= importedAttachmentBytes.length,
        sizeBytes: importedAttachmentBytes.length,
        sha256: importedAttachmentSha256,
      };
    }
    if (command.type === "external.chat-history.attachments.release") {
      return { released: true };
    }
    if (command.type === "chat.relocation.hydration.begin") {
      if (hydrationFailure) throw hydrationFailure;
      hydrationDigests.set(command.snapshotId, command.transcriptSha256);
      hydrationChunks.set(command.snapshotId, []);
      return { status: "upload" };
    }
    if (command.type === "chat.relocation.hydration.chunk") {
      hydrationChunks.get(command.snapshotId)![command.chunkIndex] =
        Buffer.from(command.data, "base64");
      return { accepted: true };
    }
    if (command.type === "chat.relocation.hydration.complete") {
      return {
        snapshotId: command.snapshotId,
        transcriptSha256: hydrationDigests.get(command.snapshotId),
        threadId: `managed-${command.snapshotId}`,
        reused: false,
      };
    }
    if (command.type === "chat.sync") {
      return {
        threadId: command.threadId,
        status: "idle",
        turns: [],
      };
    }
    if (command.type === "external.chat-history.read") {
      const target = command.targets[0]!;
      const withAttachments =
        command.sourceThreadId === "source-thread-attachments";
      return externalChatReadWorkerResultSchema.parse({
        transcript: {
          sourceId: command.sourceId,
          sourceThreadId: command.sourceThreadId,
          titleProtection: protectedChatFields(command.chatId).titleProtection,
          metadata: {
            sourceThreadId: command.sourceThreadId,
            preview: "Continue building the importer",
            cwd: target.path,
            createdAt: "2026-08-14T10:00:00.000Z",
            updatedAt: "2026-08-15T10:00:00.000Z",
            source: "vscode",
            status: "not-loaded",
            modelProvider: "openai",
            cliVersion: "0.148.0",
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
                    externalAttachmentIds: withAttachments
                      ? [
                          availableExternalAttachmentId,
                          missingExternalAttachmentId,
                        ]
                      : [],
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
          attachments: withAttachments
            ? [
                {
                  id: availableExternalAttachmentId,
                  itemId: "user-one",
                  fileName: "reference.png",
                  mimeType: "image/png",
                  sizeBytes: importedAttachmentBytes.length,
                  kind: "image",
                  status: "available",
                  sha256: importedAttachmentSha256,
                  warning: null,
                },
                {
                  id: missingExternalAttachmentId,
                  itemId: "user-one",
                  fileName: "missing.png",
                  mimeType: "application/x-image",
                  sizeBytes: 0,
                  kind: "image",
                  status: "missing",
                  sha256: null,
                  warning: "The original attachment file no longer exists.",
                },
              ]
            : [],
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
          runtimeVersion: "0.148.0",
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
              cliVersion: "0.148.0",
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
    codexVersion: "0.148.0",
    codexRuntime: {
      ...unprobedCodexRuntimeReport,
      compatibility: "compatible",
      version: { raw: "0.148.0", semantic: "0.148.0" },
      initialize: {
        userAgent: "cantrip-test",
        platformFamily: "unix",
        platformOs: "darwin",
        experimentalApi: true,
      },
      methods: Object.fromEntries(
        [
          "thread/start",
          "thread/read",
          "thread/inject_items",
          "skills/list",
          "permissionProfile/list",
          "collaborationMode/list",
          "thread/settings/update",
        ].map((method) => [method, "available"] as const),
      ),
      degradedReasons: [],
    },
    externalCodexHistory,
    startedAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await recordWorker("local-worker", "Local Worker", true);
  await recordWorker("offline-worker", "Offline Worker", true);
  await recordWorker("legacy-worker", "Legacy Worker", false);
  await recordWorker("unrelated-worker", "Unrelated Worker", true);
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    ...protectedProjectFields(),
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
  const primaryWorktree = (
    await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
  ).find((worktree) => worktree.workerId === "local-worker")!;
  primaryWorktreeId = primaryWorktree.id;
  await database.repository.observeProjectWorktree(
    LOCAL_USER_ID,
    projectId,
    primaryWorktree.id,
    {
      path: primaryWorktree.path,
      head: "a".repeat(40),
      branch: "main",
      detached: false,
      isPrimary: true,
      managed: true,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
      missing: false,
    },
  );
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
            modelId: DEFAULT_MODEL_ID,
            modelRouteId: DEFAULT_MODEL_ROUTE_ID,
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
      if (job.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(job).toMatchObject({
      state: "succeeded",
      chatId: expect.any(String),
      managedThreadId: expect.stringMatching(/^managed-/u),
      targetModelRouteId: DEFAULT_MODEL_ROUTE_ID,
      sourceMetadata: expect.not.objectContaining({ title: expect.anything() }),
    });
    expect(
      requests.filter(
        ({ command }) => command.type === "external.chat-history.read",
      ),
    ).toHaveLength(1);

    const chats = chatWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/chats`,
        })
      ).json(),
    );
    expect(chats.find(({ id }) => id === job.chatId)).toMatchObject({
      titleProtection: expect.any(Object),
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
    expect(
      await database.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        job.chatId!,
      ),
    ).toMatchObject({
      threadId: job.managedThreadId,
      workerId: "local-worker",
      worktreeId: primaryWorktreeId,
    });
    const resumed = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      job.chatId!,
      "user",
      "Continue imported chat",
    );
    expect(resumed).toMatchObject({
      threadId: job.managedThreadId,
      workerId: "local-worker",
      worktreeId: primaryWorktreeId,
    });
    await database.repository.finishChatExecutionLane(
      job.chatId!,
      resumed!.executionLaneId,
      "idle",
    );
    const hydratedPayload = JSON.parse(
      Buffer.concat(hydrationChunks.get(job.id) ?? []).toString("utf8"),
    ) as { messages: Array<{ role: string }> };
    expect(hydratedPayload.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(
      requests.some(
        ({ command }) =>
          command.type === "chat.sync" &&
          command.threadId === job.managedThreadId,
      ),
    ).toBe(true);

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
            modelId: DEFAULT_MODEL_ID,
            modelRouteId: DEFAULT_MODEL_ROUTE_ID,
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

  it("annotates metadata with durable already-imported state", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/external-chat-history`,
    });

    expect(response.statusCode).toBe(200);
    const result = projectExternalChatDiscoverySchema.parse(response.json());
    expect(
      result.workers.find(({ workerId }) => workerId === "local-worker")
        ?.sources[0]?.threads[0]?.existingImport,
    ).toMatchObject({
      projectId,
      chatId: expect.any(String),
      state: "succeeded",
    });
  });

  it("relays safe media and keeps unavailable media as visible placeholders", async () => {
    requests.length = 0;
    attachmentUploads.clear();
    attachmentFiles.clear();
    const create = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat-imports`,
      payload: {
        imports: [
          {
            sourceKind: "chatgpt-codex",
            sourceWorkerId: "local-worker",
            sourceId: "a".repeat(64),
            sourceThreadId: "source-thread-attachments",
            idempotencyKey: "import-source-thread-attachments",
            target: {
              kind: "worktree",
              projectId,
              worktreeId: primaryWorktreeId,
            },
            modelId: DEFAULT_MODEL_ID,
            modelRouteId: DEFAULT_MODEL_ROUTE_ID,
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
      if (job.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(job).toMatchObject({
      state: "succeeded",
      attachmentCount: 2,
      attachmentWarningCount: 1,
    });
    const messages = chatMessageListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/chats/${job.chatId}/messages`,
        })
      ).json(),
    );
    const attachments = messages.flatMap((message) =>
      message.content.flatMap((item) =>
        item.type === "attachment" ? [item.attachment] : [],
      ),
    );
    expect(attachments).toHaveLength(2);
    const ready = attachments.find(({ status }) => status === "ready")!;
    const missing = attachments.find(({ status }) => status === "failed")!;
    expect(ready).toMatchObject({
      fileName: "reference.png",
      sizeBytes: importedAttachmentBytes.length,
    });
    expect(missing).toMatchObject({
      fileName: "missing.png",
      previewText: "The original attachment file no longer exists.",
    });
    expect(
      requests.filter(
        ({ command }) =>
          command.type === "external.chat-history.attachment.read",
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        ({ command }) =>
          command.type === "external.chat-history.attachments.release",
      ),
    ).toHaveLength(1);
    expect(attachmentFiles.get(ready.id)).toEqual(importedAttachmentBytes);

    const hydratedPayload = JSON.parse(
      Buffer.concat(hydrationChunks.get(job.id) ?? []).toString("utf8"),
    ) as {
      attachments: Array<{
        attachment: { id: string; status: string };
        availableWorkerIds: string[];
      }>;
    };
    expect(hydratedPayload.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attachment: expect.objectContaining({
            id: ready.id,
            status: "ready",
          }),
          availableWorkerIds: ["local-worker"],
        }),
        expect.objectContaining({
          attachment: expect.objectContaining({
            id: missing.id,
            status: "failed",
          }),
          availableWorkerIds: [],
        }),
      ]),
    );

    const readyContent = await app.inject({
      method: "GET",
      url: `/api/attachments/${ready.id}/content`,
    });
    expect(readyContent.statusCode).toBe(200);
    expect(readyContent.rawPayload).toEqual(importedAttachmentBytes);
    const missingContent = await app.inject({
      method: "GET",
      url: `/api/attachments/${missing.id}/content`,
    });
    expect(missingContent.statusCode).toBe(409);
    expect(missingContent.json()).toMatchObject({
      error: "The original attachment file no longer exists.",
    });
  });

  it("rejects model routes and provider accounts outside the selected owner route", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat-imports`,
      payload: {
        imports: [
          {
            sourceKind: "chatgpt-codex",
            sourceWorkerId: "local-worker",
            sourceId: "e".repeat(64),
            sourceThreadId: "source-thread-invalid-account",
            idempotencyKey: "import-source-thread-invalid-account",
            target: {
              kind: "worktree",
              projectId,
              worktreeId: primaryWorktreeId,
            },
            modelId: DEFAULT_MODEL_ID,
            modelRouteId: DEFAULT_MODEL_ROUTE_ID,
            providerAccountId: "00000000-0000-4000-8000-000000000099",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: expect.stringMatching(/provider account/iu),
    });
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
        if (job.state === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(job).toMatchObject({
        state: "succeeded",
        chatId: expect.any(String),
        managedThreadId: expect.stringMatching(/^managed-/u),
        error: null,
      });
    } finally {
      connectedWorkers.delete("offline-worker");
    }
  });

  it("retains the canonical transcript when hydration fails and retries without rereading the source", async () => {
    requests.length = 0;
    hydrationFailure = new Error("Hydration transport failed.");
    try {
      const create = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/chat-imports`,
        payload: {
          imports: [
            {
              sourceKind: "chatgpt-codex",
              sourceWorkerId: "local-worker",
              sourceId: "c".repeat(64),
              sourceThreadId: "source-thread-hydration-retry",
              idempotencyKey: "import-source-thread-hydration-retry",
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
        chatId: expect.any(String),
        error: { code: "worker-error", retryable: true },
      });
      expect(
        chatMessageListSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/chats/${job.chatId}/messages`,
            })
          ).json(),
        ),
      ).toHaveLength(2);
      await expect(
        database.repository.startChatExecutionLane(
          LOCAL_USER_ID,
          job.chatId!,
          "user",
          "Must not continue before hydration",
        ),
      ).rejects.toThrow(/must finish runtime hydration/iu);

      hydrationFailure = null;
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
        if (job.state === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(job).toMatchObject({
        state: "succeeded",
        managedThreadId: expect.stringMatching(/^managed-/u),
        error: null,
      });
      expect(
        requests.filter(
          ({ command }) =>
            command.type === "external.chat-history.read" &&
            command.sourceThreadId === "source-thread-hydration-retry",
        ),
      ).toHaveLength(1);
    } finally {
      hydrationFailure = null;
    }
  });
});
