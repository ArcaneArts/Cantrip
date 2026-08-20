import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  externalChatTranscriptSchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-import-jobs-"),
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

let database: DatabaseConnection;
let projectId: string;
let projectReplicaId: string;
let worktreeId: string;
let worktreePath: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "import-worker",
    name: "Import Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.147.0",
    codexRuntime: unprobedCodexRuntimeReport,
    externalCodexHistory: true,
    startedAt: "2026-08-15T00:00:00.000Z",
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "import-worker",
    ...protectedProjectFields(),
    repositoryId: "chat-import-recovery",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  worktreePath = path.join(dataDirectory, "import-worker", "Cantrip");
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "import-worker",
    {
      path: worktreePath,
      displayPath: worktreePath,
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const worktree = (
    await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId)
  )[0]!;
  projectReplicaId = worktree.projectSourceId;
  worktreeId = worktree.id;
});

afterAll(async () => {
  await database?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("chat import job durability", () => {
  it("recovers an interrupted post-canonical hydration without rereading the source", async () => {
    const sourceThreadId = "source-thread-recovery";
    const created = await database.repository.chatImportJobs.create(
      LOCAL_USER_ID,
      projectId,
      {
        sourceKind: "chatgpt-codex",
        sourceWorkerId: "import-worker",
        sourceId: "d".repeat(64),
        sourceThreadId,
        targetPlacement: {
          projectId,
          workerId: "import-worker",
          projectReplicaId,
          worktreeId,
          surface: null,
        },
        modelId: null,
        modelRouteId: null,
        providerAccountId: null,
        permissionProfileId: null,
        planMode: "default",
        idempotencyKey: "chat-import-recovery",
      },
    );
    const reading = await database.repository.chatImportJobs.claimNext();
    expect(reading?.job).toMatchObject({ id: created.id, state: "reading" });
    const importing = await database.repository.chatImportJobs.markImporting(
      created.id,
      reading!.commandId,
      reading!.job.attempt,
    );
    const canonical =
      await database.repository.chatImportJobs.completeCanonicalImport(
        created.id,
        reading!.commandId,
        importing.attempt,
        externalChatTranscriptSchema.parse({
          sourceId: "d".repeat(64),
          sourceThreadId,
          titleProtection: protectedChatFields(created.id).titleProtection,
          metadata: {
            sourceThreadId,
            preview: "Durable hydration",
            cwd: worktreePath,
            createdAt: "2026-08-14T10:00:00.000Z",
            updatedAt: "2026-08-15T10:00:00.000Z",
            source: "vscode",
            status: "not-loaded",
            modelProvider: "openai",
            cliVersion: "0.147.0",
            git: null,
            match: {
              kind: "worktree-path",
              projectReplicaId,
              worktreeId,
            },
          },
          sync: {
            threadId: sourceThreadId,
            status: "idle",
            turns: [
              {
                id: "turn-recovery",
                status: "completed",
                startedAt: 1_786_800_000,
                completedAt: 1_786_800_010,
                durationMs: 10_000,
                items: [
                  {
                    type: "userMessage",
                    id: "user-recovery",
                    text: "Keep this message across a restart.",
                  },
                  {
                    type: "agentMessage",
                    id: "agent-recovery",
                    text: "It is stored canonically.",
                    phase: "final_answer",
                    correlation: {
                      diagnosticId: null,
                      threadId: sourceThreadId,
                      turnId: "turn-recovery",
                      itemId: "agent-recovery",
                      sourceMethod: "thread/read",
                    },
                  },
                ],
              },
            ],
          },
        }),
        [],
        async (messages) =>
          messages.map((message) => ({
            id: message.id,
            classification: {
              role: message.role,
              mode: message.mode ?? "default",
              attachmentIds: message.content.flatMap((item) =>
                item.type === "attachment" ? [item.attachment.id] : [],
              ),
            },
            protectedContent: {
              formatVersion: 1,
              keyRevision: 1,
              envelope: {
                version: 1,
                algorithm: "AES-256-GCM" as const,
                keyRevision: 1,
                nonce: "AAAAAAAAAAAAAAAA",
                ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
              },
            },
            reasoningEffort: message.reasoningEffort ?? null,
            idempotencyKey: message.idempotencyKey,
          })),
      );
    expect(canonical).toMatchObject({
      state: "awaiting-hydration",
      chatId: expect.any(String),
    });

    const hydrating = await database.repository.chatImportJobs.claimNext();
    expect(hydrating?.job).toMatchObject({
      id: created.id,
      state: "hydrating",
      chatId: canonical.chatId,
    });
    expect(
      await database.repository.chatImportJobs.recoverInterrupted(true),
    ).toBe(1);
    expect(
      await database.repository.chatImportJobs.get(LOCAL_USER_ID, created.id),
    ).toMatchObject({
      state: "awaiting-hydration",
      chatId: canonical.chatId,
      managedThreadId: null,
    });

    const reclaimed = await database.repository.chatImportJobs.claimNext();
    expect(reclaimed?.job).toMatchObject({
      id: created.id,
      state: "hydrating",
      chatId: canonical.chatId,
    });
    const hydration = await database.repository.chatImportJobs.hydrationContext(
      created.id,
      reclaimed!.commandId,
    );
    expect(hydration?.payload.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
    ]);
    const blocked = await database.repository.chatImportJobs.block(
      created.id,
      reclaimed!.commandId,
      {
        code: "capability-missing",
        message: "Required hydration methods are unavailable.",
        retryable: false,
      },
    );
    expect(blocked).toMatchObject({
      state: "blocked",
      chatId: canonical.chatId,
    });
    expect(
      await database.repository.chatImportJobs.completeUnsupportedHydrationImports(),
    ).toBe(1);
    const completed = await database.repository.chatImportJobs.get(
      LOCAL_USER_ID,
      created.id,
    );
    expect(completed).toMatchObject({
      state: "succeeded",
      chatId: canonical.chatId,
      managedThreadId: null,
      error: null,
      progress: {
        percent: 100,
        message:
          "Chat history is imported. A new runtime will start when you continue.",
      },
    });
    const resumed = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      canonical.chatId!,
      "user",
      "Continue best-effort import",
    );
    expect(resumed).toMatchObject({
      chatId: canonical.chatId,
      threadId: null,
      workerId: "import-worker",
      worktreeId,
    });
    await database.repository.finishChatExecutionLane(
      canonical.chatId!,
      resumed.executionLaneId,
      "idle",
    );
  });
});
