import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { ChatRelocationJobConflictError } from "../src/db/chat-relocation-jobs.js";
import {
  DEFAULT_MODEL_ROUTE_ID,
  ExecutionLaneConflictError,
  LOCAL_USER_ID,
} from "../src/db/repository.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-relocation-jobs-"),
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
let alphaWorktreeId: string;
let betaWorktreeId: string;
let betaReplicaId: string;

async function createChat(title: string) {
  const chat = await database.repository.createChat(
    LOCAL_USER_ID,
    projectId,
    {
      title,
      worktreeId: alphaWorktreeId,
      worktreeMode: "agent-managed",
    },
    () => true,
  );
  return chat!;
}

function betaPlacement(chatId: string) {
  return {
    projectId,
    workerId: "worker-beta",
    projectReplicaId: betaReplicaId,
    worktreeId: betaWorktreeId,
    surface: { kind: "chat" as const, id: chatId },
  };
}

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureLocalIdentity();
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  for (const [workerId, name] of [
    ["worker-alpha", "Alpha"],
    ["worker-beta", "Beta"],
  ] as const) {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId,
      name,
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
      projectReplicas: {
        provision: true,
        synchronize: true,
        remove: true,
        exactRevision: true,
      },
      startedAt: "2026-08-12T00:00:00.000Z",
    });
  }
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "worker-alpha",
    repositoryId: "chat-relocation-project",
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
  const alpha = worktrees.find(({ workerId }) => workerId === "worker-alpha")!;
  const beta = worktrees.find(({ workerId }) => workerId === "worker-beta")!;
  alphaWorktreeId = alpha.id;
  betaWorktreeId = beta.id;
  betaReplicaId = beta.projectSourceId;
  for (const worktree of [alpha, beta]) {
    await database.repository.observeProjectWorktree(
      LOCAL_USER_ID,
      projectId,
      worktree.id,
      {
        path: worktree.path,
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
  }
});

afterAll(async () => {
  await database?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("durable chat relocation jobs", () => {
  it("snapshots the complete canonical transcript and commits placement atomically", async () => {
    const chat = await createChat("Relocate me");
    const attachment = await database.repository.createChatAttachment(
      LOCAL_USER_ID,
      chat.id,
      {
        id: "attachment-relocation-one",
        workerId: "worker-alpha",
        fileName: "context.txt",
        mimeType: "text/plain",
        sizeBytes: 7,
        kind: "text",
        source: "file",
        previewText: "context",
        sha256: "a".repeat(64),
      },
    );
    expect(attachment).not.toBeNull();
    await database.repository.appendMessage(LOCAL_USER_ID, chat.id, {
      role: "user",
      content: [
        { type: "text", text: "Use this context." },
        { type: "attachment", attachment: attachment! },
      ],
      idempotencyKey: "relocation-message-user",
    });
    await database.repository.appendMessage(LOCAL_USER_ID, chat.id, {
      role: "assistant",
      content: [{ type: "text", text: "Context received." }],
      idempotencyKey: "relocation-message-assistant",
    });

    const job = await database.repository.chatRelocationJobs.create(
      LOCAL_USER_ID,
      chat.id,
      betaPlacement(chat.id),
      "relocate:complete-transcript",
    );
    expect(job).toMatchObject({
      state: "queued",
      sourcePlacementRevision: 1,
      sourcePlacement: {
        workerId: "worker-alpha",
        worktreeId: alphaWorktreeId,
      },
      targetPlacement: {
        workerId: "worker-beta",
        worktreeId: betaWorktreeId,
      },
    });
    const replay = await database.repository.chatRelocationJobs.create(
      LOCAL_USER_ID,
      chat.id,
      betaPlacement(chat.id),
      "relocate:complete-transcript",
    );
    expect(replay.id).toBe(job.id);
    await expect(
      database.repository.chatRelocationJobs.create(
        LOCAL_USER_ID,
        chat.id,
        {
          ...betaPlacement(chat.id),
          workerId: "worker-alpha",
        },
        "relocate:complete-transcript",
      ),
    ).rejects.toBeInstanceOf(ChatRelocationJobConflictError);

    const snapshot = await database.repository.chatRelocationJobs.getSnapshot(
      LOCAL_USER_ID,
      job.id,
    );
    expect(snapshot).toMatchObject({
      summary: {
        throughSequence: 2,
        messageCount: 2,
        attachmentCount: 1,
        transcriptSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      payload: {
        version: 1,
        messages: [
          expect.objectContaining({ sequence: 1, role: "user" }),
          expect.objectContaining({ sequence: 2, role: "assistant" }),
        ],
        attachments: [
          expect.objectContaining({
            sha256: "a".repeat(64),
            sourceWorkerId: "worker-alpha",
            availableWorkerIds: ["worker-alpha"],
          }),
        ],
      },
    });

    const claimed = await database.repository.chatRelocationJobs.claimNext();
    expect(claimed?.job.id).toBe(job.id);
    let advanced = await database.repository.chatRelocationJobs.advance(
      job.id,
      claimed!.commandId,
      1,
      "validating",
      "preparing-replica",
      { stage: "preparing-replica", percent: 20, message: "Replica ready." },
    );
    advanced = await database.repository.chatRelocationJobs.advance(
      job.id,
      claimed!.commandId,
      advanced.attempt,
      "preparing-replica",
      "transferring-attachments",
      { stage: "transferring-attachments", percent: 45, message: "Copying." },
    );
    advanced = await database.repository.chatRelocationJobs.advance(
      job.id,
      claimed!.commandId,
      advanced.attempt,
      "transferring-attachments",
      "hydrating-runtime",
      { stage: "hydrating-runtime", percent: 70, message: "Hydrating." },
    );
    advanced = await database.repository.chatRelocationJobs.advance(
      job.id,
      claimed!.commandId,
      advanced.attempt,
      "hydrating-runtime",
      "ready-to-commit",
      { stage: "ready-to-commit", percent: 95, message: "Runtime ready." },
      {
        cancellationUnsafe: true,
        targetModelRouteId: DEFAULT_MODEL_ROUTE_ID,
        targetRuntimeThreadId: "thread-beta",
      },
    );
    const committed = await database.repository.chatRelocationJobs.commit(
      job.id,
      claimed!.commandId,
      advanced.attempt,
    );
    expect(committed).toMatchObject({
      chat: {
        activeWorkerId: "worker-beta",
        activeWorktreeId: betaWorktreeId,
        placementRevision: 2,
      },
      job: { state: "succeeded", targetRuntimeThreadId: "thread-beta" },
    });
  });

  it("waits for idle, supports safe cancellation, and leaves placement intact on stale commit", async () => {
    const waitingChat = await createChat("Wait for idle");
    await database.repository.setChatStatus(waitingChat.id, "running");
    const waitingJob = await database.repository.chatRelocationJobs.create(
      LOCAL_USER_ID,
      waitingChat.id,
      betaPlacement(waitingChat.id),
      "relocate:wait-for-idle",
    );
    expect(waitingJob.state).toBe("waiting-for-idle");
    expect(await database.repository.chatRelocationJobs.claimNext()).toBeNull();
    const completedMessage = await database.repository.appendMessage(
      LOCAL_USER_ID,
      waitingChat.id,
      {
        role: "assistant",
        content: [{ type: "text", text: "The active turn completed." }],
        idempotencyKey: "relocation-waiting-completion",
      },
    );
    await database.repository.setChatStatus(waitingChat.id, "idle");
    await expect(
      database.repository.startChatExecutionLane(
        LOCAL_USER_ID,
        waitingChat.id,
        "user",
        "Should remain frozen",
      ),
    ).rejects.toBeInstanceOf(ExecutionLaneConflictError);
    const waitingClaim =
      await database.repository.chatRelocationJobs.claimNext();
    expect(waitingClaim?.job.id).toBe(waitingJob.id);
    expect(waitingClaim?.snapshot).toMatchObject({
      summary: {
        messageCount: 1,
        throughSequence: completedMessage!.sequence,
      },
      payload: {
        messages: [
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "The active turn completed." }],
          }),
        ],
      },
    });
    const cancelled = await database.repository.chatRelocationJobs.cancel(
      LOCAL_USER_ID,
      waitingJob.id,
      waitingClaim!.job.stateRevision,
    );
    expect(cancelled.state).toBe("cancelled");

    const staleChat = await createChat("Stale source");
    const staleJob = await database.repository.chatRelocationJobs.create(
      LOCAL_USER_ID,
      staleChat.id,
      betaPlacement(staleChat.id),
      "relocate:stale-source",
    );
    const staleClaim = await database.repository.chatRelocationJobs.claimNext();
    expect(staleClaim?.job.id).toBe(staleJob.id);
    let advanced = await database.repository.chatRelocationJobs.advance(
      staleJob.id,
      staleClaim!.commandId,
      staleClaim!.job.attempt,
      "validating",
      "preparing-replica",
      { stage: "preparing-replica", percent: 20, message: "Ready." },
    );
    for (const [from, to, percent] of [
      ["preparing-replica", "transferring-attachments", 45],
      ["transferring-attachments", "hydrating-runtime", 70],
      ["hydrating-runtime", "ready-to-commit", 95],
    ] as const) {
      advanced = await database.repository.chatRelocationJobs.advance(
        staleJob.id,
        staleClaim!.commandId,
        advanced.attempt,
        from,
        to,
        { stage: to, percent, message: "Advancing." },
        to === "ready-to-commit"
          ? {
              cancellationUnsafe: true,
              targetModelRouteId: DEFAULT_MODEL_ROUTE_ID,
              targetRuntimeThreadId: "thread-stale",
            }
          : {},
      );
    }
    await database.repository.setChatStatus(staleChat.id, "running");
    const stale = await database.repository.chatRelocationJobs.commit(
      staleJob.id,
      staleClaim!.commandId,
      advanced.attempt,
    );
    expect(stale).toMatchObject({
      chat: {
        activeWorkerId: "worker-alpha",
        activeWorktreeId: alphaWorktreeId,
        placementRevision: 1,
      },
      job: { state: "failed", error: { code: "stale-attempt" } },
    });
    await database.repository.setChatStatus(staleChat.id, "idle");
  });

  it("recovers interrupted attempts with the same immutable snapshot", async () => {
    const chat = await createChat("Recover relocation");
    await database.repository.appendMessage(LOCAL_USER_ID, chat.id, {
      role: "user",
      content: [{ type: "text", text: "Preserve all of this context." }],
      idempotencyKey: "relocation-recovery-message",
    });
    const job = await database.repository.chatRelocationJobs.create(
      LOCAL_USER_ID,
      chat.id,
      betaPlacement(chat.id),
      "relocate:recover",
    );
    const snapshot = await database.repository.chatRelocationJobs.getSnapshot(
      LOCAL_USER_ID,
      job.id,
    );
    const firstAttempt =
      await database.repository.chatRelocationJobs.claimNext();
    expect(firstAttempt?.job).toMatchObject({ id: job.id, attempt: 1 });
    await database.repository.chatRelocationJobs.advance(
      job.id,
      firstAttempt!.commandId,
      firstAttempt!.job.attempt,
      "validating",
      "preparing-replica",
      { stage: "preparing-replica", percent: 20, message: "Preparing." },
    );
    expect(
      await database.repository.chatRelocationJobs.recoverInterrupted(false),
    ).toBe(0);
    expect(
      await database.repository.chatRelocationJobs.renewLease(
        job.id,
        firstAttempt!.commandId,
        firstAttempt!.job.attempt,
      ),
    ).toBe(true);

    await database.close();
    database = await connectDatabase(config);
    expect(
      await database.repository.chatRelocationJobs.recoverInterrupted(),
    ).toBe(1);
    expect(
      await database.repository.chatRelocationJobs.get(LOCAL_USER_ID, job.id),
    ).toMatchObject({ state: "queued", attempt: 1 });
    expect(
      await database.repository.chatRelocationJobs.getSnapshot(
        LOCAL_USER_ID,
        job.id,
      ),
    ).toMatchObject({
      summary: { transcriptSha256: snapshot!.summary.transcriptSha256 },
      payload: { messages: snapshot!.payload.messages },
    });
    const secondAttempt =
      await database.repository.chatRelocationJobs.claimNext();
    expect(secondAttempt?.job).toMatchObject({ id: job.id, attempt: 2 });
    expect(
      await database.repository.chatRelocationJobs.cancel(
        LOCAL_USER_ID,
        job.id,
        secondAttempt!.job.stateRevision,
      ),
    ).toMatchObject({ state: "cancelled", attempt: 2 });
  });

  it("rejects the legacy immediate switch path across workers", async () => {
    const chat = await createChat("Legacy guard");
    await expect(
      database.repository.updateChatWorktree(LOCAL_USER_ID, chat.id, {
        worktreeId: betaWorktreeId,
        mode: "pinned",
      }),
    ).rejects.toThrow(
      "Moving a chat to another worker requires a durable relocation.",
    );
    expect(
      (await database.repository.listChats(LOCAL_USER_ID, projectId)).find(
        ({ id }) => id === chat.id,
      ),
    ).toMatchObject({
      activeWorkerId: "worker-alpha",
      activeWorktreeId: alphaWorktreeId,
      placementRevision: 1,
    });
  });
});
