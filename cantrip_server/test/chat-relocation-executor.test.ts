import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unprobedCodexRuntimeReport,
  type ChatRelocationJobSummary,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CHAT_RELOCATION_HYDRATION_TIMEOUT_MS,
  ChatRelocationJobExecutor,
} from "../src/chat-relocations/executor.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-relocation-executor-"),
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

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureLocalIdentity();
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
});

afterAll(async () => {
  await database?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

const requiredMethods = Object.fromEntries(
  [
    "thread/start",
    "thread/inject_items",
    "thread/unsubscribe",
    "skills/list",
    "permissionProfile/list",
    "collaborationMode/list",
    "thread/settings/update",
  ].map((method) => [method, "available"] as const),
);

function worktreeStatus(worktreePath: string, revision: string) {
  return {
    worktree: {
      path: worktreePath,
      head: revision,
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
    status: {
      branch: "main",
      head: revision,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      files: [],
      branches: [],
    },
  };
}

describe.sequential("chat relocation executor", () => {
  it("hydrates the full snapshot and commits only after target preparation", async () => {
    for (const [workerId, name] of [
      ["worker-source", "Source"],
      ["worker-target", "Target"],
    ] as const) {
      await database.repository.recordWorker(LOCAL_USER_ID, {
        workerId,
        name,
        platform: "linux",
        architecture: "x64",
        codexVersion: "0.146.1",
        codexRuntime: {
          ...unprobedCodexRuntimeReport,
          compatibility: "partial",
          version: { raw: "0.146.1", semantic: "0.146.1" },
          initialize: {
            userAgent: "test",
            platformFamily: "unix",
            platformOs: "linux",
            experimentalApi: true,
          },
          methods: requiredMethods,
          degradedReasons: [],
        },
        remoteSurfaces: {
          browser: false,
          desktop: false,
          transports: ["websocket"],
          maxSessions: 1,
        },
        projectReplicas: {
          provision: true,
          synchronize: true,
          remove: true,
          exactRevision: true,
        },
        chatRelocation: true,
        startedAt: "2026-08-12T00:00:00.000Z",
      });
    }
    const project = await database.repository.createGithubProject(
      LOCAL_USER_ID,
      {
        workerId: "worker-source",
        ...protectedProjectFields(),
        repositoryId: "relocation-executor-project",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    );
    for (const workerId of ["worker-source", "worker-target"]) {
      await database.repository.completeGithubProjectSetup(
        LOCAL_USER_ID,
        project.id,
        workerId,
        {
          path: path.join(dataDirectory, workerId),
          displayPath: workerId,
          reused: false,
          updated: false,
          warning: null,
        },
      );
    }
    const worktrees = await database.repository.listProjectWorktrees(
      LOCAL_USER_ID,
      project.id,
    );
    const source = worktrees.find(
      (worktree) => worktree.workerId === "worker-source",
    )!;
    const target = worktrees.find(
      (worktree) => worktree.workerId === "worker-target",
    )!;
    const revision = "a".repeat(40);
    for (const worktree of [source, target]) {
      await database.repository.observeProjectWorktree(
        LOCAL_USER_ID,
        project.id,
        worktree.id,
        worktreeStatus(worktree.path, revision).worktree,
      );
    }
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      project.id,
      {
        ...protectedChatFields(),
        worktreeId: source.id,
        worktreeMode: "agent-managed",
      },
      () => true,
      () => true,
    );
    const provider = await database.repository.createModelProvider(
      LOCAL_USER_ID,
      {
        name: "Portable ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    );
    const account = provider.accounts[0]!;
    await database.repository.storeModelProviderAccountCredential(
      LOCAL_USER_ID,
      provider.id,
      account.id,
      {
        accessToken: "server-owned-access-token",
        accountId: "upstream-workspace",
        email: "person@example.test",
        expiresAt: Date.now() + 3_600_000,
        idToken: "server-owned-identity-token",
        kind: "chatgpt",
        planType: "pro",
        refreshToken: "server-owned-refresh-token",
        userId: "upstream-user",
        version: 1,
      },
    );
    const portableModel = await database.repository.createModelProfile(
      LOCAL_USER_ID,
      {
        name: "Portable Codex",
        routes: [
          {
            providerId: provider.id,
            modelName: "gpt-5.6-sol",
            enabled: true,
          },
        ],
      },
    );
    await database.repository.setChatModel(LOCAL_USER_ID, chat!.id, {
      modelId: portableModel!.id,
    });
    const attachmentBytes = Buffer.from("context", "utf8");
    const attachmentSha256 = createHash("sha256")
      .update(attachmentBytes)
      .digest("hex");
    const attachment = await database.repository.createChatAttachment(
      LOCAL_USER_ID,
      chat!.id,
      {
        id: "executor-attachment-one",
        workerId: "worker-source",
        fileName: "context.txt",
        mimeType: "text/plain",
        sizeBytes: attachmentBytes.byteLength,
        kind: "text",
        source: "file",
        previewText: "context",
        sha256: attachmentSha256,
      },
    );
    await database.repository.appendMessage(LOCAL_USER_ID, chat!.id, {
      role: "user",
      content: [
        { type: "text", text: "Remember the complete transcript." },
        { type: "attachment", attachment: attachment! },
      ],
      idempotencyKey: "executor-message-one",
    });
    await database.repository.appendMessage(LOCAL_USER_ID, chat!.id, {
      role: "assistant",
      content: [{ type: "text", text: "I will." }],
      idempotencyKey: "executor-message-two",
    });
    await database.repository.updateChatRuntime(
      chat!.id,
      "worker-source",
      source.id,
      "thread-source",
      portableModel!.routes[0]!.id,
      "ready",
      account.id,
    );
    const job = await database.repository.chatRelocationJobs.create(
      LOCAL_USER_ID,
      chat!.id,
      {
        projectId: project.id,
        workerId: "worker-target",
        projectReplicaId: target.projectSourceId,
        worktreeId: target.id,
        surface: { kind: "chat", id: chat!.id },
      },
      "executor-relocation-one",
    );

    const commands: WorkerCommand[] = [];
    const hydrationChunks: Buffer[] = [];
    const attachmentChunks: Buffer[] = [];
    let hydrationDigest = "";
    let hydrationCompleteTimeout: number | null | undefined;
    const bridge = {
      isConnected: () => true,
      request: async (
        _workerId: string,
        command: WorkerCommand,
        options?: { timeoutMs?: number | null },
      ) => {
        commands.push(command);
        if (command.type === "worktree.status") {
          return worktreeStatus(command.worktreePath, revision);
        }
        if (command.type === "attachment.upload.begin") {
          return { accepted: true };
        }
        if (command.type === "attachment.read") {
          const bytes = attachmentBytes.subarray(
            command.offset,
            command.offset + command.limit,
          );
          return {
            data: bytes.toString("base64"),
            eof:
              command.offset + bytes.byteLength >= attachmentBytes.byteLength,
            sizeBytes: attachmentBytes.byteLength,
          };
        }
        if (command.type === "attachment.upload.chunk") {
          attachmentChunks[command.chunkIndex] = Buffer.from(
            command.data,
            "base64",
          );
          return { accepted: true };
        }
        if (command.type === "attachment.upload.complete") {
          return {
            path: "/target/context.txt",
            sha256: attachmentSha256,
            sizeBytes: attachmentBytes.byteLength,
          };
        }
        if (command.type === "attachment.delete") {
          return { accepted: true };
        }
        if (command.type === "chat.relocation.hydration.begin") {
          hydrationDigest = command.transcriptSha256;
          return { status: "upload" };
        }
        if (command.type === "chat.relocation.hydration.chunk") {
          hydrationChunks[command.chunkIndex] = Buffer.from(
            command.data,
            "base64",
          );
          return { accepted: true };
        }
        if (command.type === "chat.relocation.hydration.complete") {
          hydrationCompleteTimeout = options?.timeoutMs;
          return {
            snapshotId: command.snapshotId,
            transcriptSha256: hydrationDigest,
            threadId: "thread-target",
            reused: false,
          };
        }
        if (command.type === "chat.relocation.thread.release") {
          return { released: true };
        }
        throw new Error(`Unexpected worker command ${command.type}.`);
      },
    } as unknown as WorkerCommandBus;
    const changes: ChatRelocationJobSummary[] = [];
    const executor = new ChatRelocationJobExecutor(
      database.repository,
      bridge,
      { error: () => undefined, warn: () => undefined },
      () => undefined,
      (change) => changes.push(change.job),
    );
    executor.queueAvailable();
    await executor.drain();

    expect(
      await database.repository.chatRelocationJobs.get(LOCAL_USER_ID, job.id),
    ).toMatchObject({
      state: "succeeded",
      targetRuntimeThreadId: "thread-target",
    });
    expect(
      await database.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chat!.id,
      ),
    ).toMatchObject({
      workerId: "worker-target",
      worktreeId: target.id,
      threadId: "thread-target",
      modelId: portableModel!.id,
      modelRouteId: portableModel!.routes[0]!.id,
      providerAccountId: account.id,
    });
    const hydratedPayload = JSON.parse(
      Buffer.concat(hydrationChunks).toString("utf8"),
    ) as { messages: unknown[] };
    expect(hydratedPayload.messages).toHaveLength(2);
    expect(Buffer.concat(attachmentChunks)).toEqual(attachmentBytes);
    expect(
      await database.repository.chatRelocationJobs.isAttachmentAvailable(
        attachment!.id,
        "worker-target",
      ),
    ).toBe(true);
    expect(commands.map((command) => command.type)).toContain(
      "chat.relocation.hydration.complete",
    );
    expect(
      commands.find(
        (command) => command.type === "chat.relocation.hydration.begin",
      ),
    ).toMatchObject({
      model: { id: portableModel!.id, routeId: portableModel!.routes[0]!.id },
      provider: {
        id: provider.id,
        accountId: account.id,
        credentialHomeKey: provider.id,
      },
    });
    expect(hydrationCompleteTimeout).toBe(CHAT_RELOCATION_HYDRATION_TIMEOUT_MS);
    expect(commands.at(-1)).toMatchObject({
      type: "chat.relocation.thread.release",
      threadId: "thread-source",
    });
    expect(changes.at(-1)?.state).toBe("succeeded");

    const offlineChat = await database.repository.createChat(
      LOCAL_USER_ID,
      project.id,
      {
        ...protectedChatFields(),
        worktreeId: source.id,
        worktreeMode: "agent-managed",
      },
      () => true,
      () => true,
    );
    const offlineJob = await database.repository.chatRelocationJobs.create(
      LOCAL_USER_ID,
      offlineChat!.id,
      {
        projectId: project.id,
        workerId: "worker-target",
        projectReplicaId: target.projectSourceId,
        worktreeId: target.id,
        surface: { kind: "chat", id: offlineChat!.id },
      },
      "executor-relocation-offline",
    );
    const offlineExecutor = new ChatRelocationJobExecutor(
      database.repository,
      {
        isConnected: (workerId: string) => workerId !== "worker-target",
        request: async () => {
          throw new Error("Offline targets must not receive commands.");
        },
      } as unknown as WorkerCommandBus,
      { error: () => undefined, warn: () => undefined },
      () => undefined,
    );
    offlineExecutor.queueAvailable();
    await offlineExecutor.drain();
    expect(
      await database.repository.chatRelocationJobs.get(
        LOCAL_USER_ID,
        offlineJob.id,
      ),
    ).toMatchObject({
      state: "blocked",
      error: { code: "worker-offline", retryable: true },
      progress: { stage: "blocked", percent: 5 },
    });
    expect(
      await database.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        offlineChat!.id,
      ),
    ).toMatchObject({ workerId: "worker-source", worktreeId: source.id });
  });
});
