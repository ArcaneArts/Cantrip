import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  nativeCommandAdmissionSchema,
  nativeHistoryIngestSchema,
  unprobedCodexRuntimeReport,
  type NativeHistoryTurn,
} from "@cantrip/protocol";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { installInternalNativeHistoryRoutes } from "../src/app/routes/internal-native-history.js";
import { createNativeHistoryPublicationDelivery } from "../src/app/runtime/native-history-publication-delivery.js";
import { installNativeHistoryRuntime } from "../src/app/runtime/native-history-runtime.js";
import { AppLiveHub } from "../src/live/hub.js";
import {
  openNativeHistoryTurn,
  prepareNativeHistoryTurn,
} from "../../cantrip_worker/src/native-history-turn-content.js";
import { parseCodexNativeHistory } from "../../cantrip_worker/src/codex/native-history.js";
import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(os.tmpdir(), "cantrip-native-history-bindings-"),
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
  workerToken: "history-fixture-token",
};
let database: DatabaseConnection;
let projectId: string;
const workerId = "history-fixture-worker";
const envelope = {
  version: 1 as const,
  algorithm: "AES-256-GCM" as const,
  keyRevision: 1,
  nonce: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
};

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId,
    name: "History fixture",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.153.4",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId,
    ...protectedProjectFields(),
    repositoryBlindIndex: "H".repeat(43),
    repositoryId: "history-fixture-repository",
    nameWithOwner: "Fixture/History",
    url: "https://github.com/Fixture/History",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    workerId,
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "Fixture/History",
      reused: false,
      updated: false,
      warning: null,
    },
  );
}, 60_000);

afterAll(async () => {
  await database?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

async function fixture() {
  const chat = await database.repository.createChat(LOCAL_USER_ID, projectId, {
    ...protectedChatFields(),
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Missing fixture chat");
  const boot = await database.repository.startChatExecutionLane(
    LOCAL_USER_ID,
    chat.id,
    "user",
    "Fixture session",
  );
  if (!boot?.executionLaneId) throw new Error("Missing fixture boot lane");
  const threadId = randomUUID();
  await database.repository.updateChatExecutionLaneRuntime(
    chat.id,
    boot.executionLaneId,
    threadId,
    "ready",
  );
  await database.repository.finishChatExecutionLane(
    chat.id,
    boot.executionLaneId,
    "idle",
  );
  return {
    chatId: chat.id,
    threadId,
    bootLaneId: boot.executionLaneId,
    request: {
      chatId: chat.id,
      workerId,
      threadId,
      provenance: { kind: "current" as const },
    },
  };
}

describe("durable native history ownership", () => {
  it("accounts retained encrypted history through its owner and releases bytes on cascade", async () => {
    const f = await fixture();
    const binding = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const usage = async () =>
      (await database.repository.accountResourceUsage.measureStorage()).find(
        (row) =>
          row.ownerId === LOCAL_USER_ID &&
          row.category === "conversations" &&
          row.storageClass === "server",
      )!;
    const baseline = await usage();
    const streamId = randomUUID();
    await database.repository.nativeHistoryBindings.withBinding(
      LOCAL_USER_ID,
      workerId,
      f.chatId,
      binding.id,
      async (tx) => {
        await tx
          .insert(schema.nativeHistoryStreams)
          .values({ id: streamId, bindingId: binding.id });
        await tx.insert(schema.nativeHistoryReceipts).values({
          commitId: randomUUID(),
          streamId,
          sequence: 1,
          recordId: randomUUID(),
          digest: "a".repeat(64),
          payloadDigest: "b".repeat(64),
        });
        await tx.insert(schema.nativeHistoryTurns).values({
          bindingId: binding.id,
          turnId: "storage-turn",
          revision: 1,
          ordinal: 0,
          status: "completed",
          metadata: envelope,
          payloadDigest: "c".repeat(64),
        });
      },
    );
    const created = await usage();
    expect(created.rowCount - baseline.rowCount).toBe(3n);
    expect(created.logicalBytes).toBeGreaterThan(baseline.logicalBytes);
    await database.repository.nativeHistoryBindings.withBinding(
      LOCAL_USER_ID,
      workerId,
      f.chatId,
      binding.id,
      async (tx) => {
        await tx
          .update(schema.nativeHistoryTurns)
          .set({ metadata: { ...envelope, ciphertext: "A".repeat(8192) } })
          .where(eq(schema.nativeHistoryTurns.bindingId, binding.id));
      },
    );
    expect((await usage()).logicalBytes).toBeGreaterThan(created.logicalBytes);
    await database.repository.nativeHistoryBindings.withBinding(
      LOCAL_USER_ID,
      workerId,
      f.chatId,
      binding.id,
      async (tx) => {
        // Removing the stream must also remove its retained receipts.
        await tx
          .delete(schema.nativeHistoryStreams)
          .where(eq(schema.nativeHistoryStreams.id, streamId));
        await tx
          .delete(schema.nativeHistoryTurns)
          .where(eq(schema.nativeHistoryTurns.bindingId, binding.id));
      },
    );
    expect(await usage()).toEqual(baseline);
  });

  it("derives immutable child ancestry from an owned historical parent after the root session retires", async () => {
    const f = await fixture();
    const parent = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const childRequest = {
      ...f.request,
      threadId: randomUUID(),
      provenance: { kind: "child" as const, parentBindingId: parent.id },
    };
    const child = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      childRequest,
    );
    expect(child.ancestorThreadIds).toEqual([parent.threadId]);
    expect(child.worktreeId).toBe(parent.worktreeId);
    const grandchild = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      {
        ...childRequest,
        threadId: randomUUID(),
        provenance: { kind: "child", parentBindingId: child.id },
      },
    );
    expect(grandchild.ancestorThreadIds).toEqual([
      parent.threadId,
      child.threadId,
    ]);
    expect(
      await database.repository.nativeHistoryBindings.open(
        LOCAL_USER_ID,
        childRequest,
      ),
    ).toEqual(child);
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...childRequest,
        provenance: { kind: "child", parentBindingId: grandchild.id },
      }),
    ).rejects.toMatchObject({ code: "invalid-child-ancestry" });
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...childRequest,
        threadId: grandchild.threadId,
      }),
    ).rejects.toMatchObject({ code: "child-parent-mismatch" });
    expect(
      await database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...childRequest,
        provenance: { kind: "binding", bindingId: child.id },
      }),
    ).toEqual(child);
    expect(
      (
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          f.chatId,
        )
      )?.threadId,
    ).toBe(parent.threadId);
  });

  it("refuses unrelated parent bindings and root-to-child relabeling", async () => {
    const a = await fixture();
    const b = await fixture();
    const parent = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      a.request,
    );
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...b.request,
        threadId: randomUUID(),
        provenance: { kind: "child", parentBindingId: parent.id },
      }),
    ).rejects.toMatchObject({ code: "parent-binding-not-found" });
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...a.request,
        provenance: { kind: "child", parentBindingId: parent.id },
      }),
    ).rejects.toMatchObject({ code: "invalid-child-ancestry" });
  });

  it("binds an idle native session once without activating it or changing configuration", async () => {
    const f = await fixture();
    const before = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      f.chatId,
    );
    const [a, b] = await Promise.all([
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, f.request),
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, f.request),
    ]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      chatId: f.chatId,
      threadId: f.threadId,
      workerId,
      projectId,
    });
    const after = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      f.chatId,
    );
    expect(after).toEqual(before);
    expect(after?.executionLaneId).toBeNull();
    expect(after?.status).toBe("idle");
    expect(a).not.toHaveProperty("computerUseAuthority");
    await database.repository.nativeHistoryBindings.withBinding(
      LOCAL_USER_ID,
      workerId,
      f.chatId,
      a.id,
      async (tx) => {
        const rows = await tx
          .select()
          .from(schema.nativeHistoryBindings)
          .where(eq(schema.nativeHistoryBindings.chatId, f.chatId));
        expect(rows).toHaveLength(1);
        const activations = await tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, f.chatId));
        expect(activations).toEqual([]);
      },
    );
  });

  it("retains old-thread observation after replacement and database restart", async () => {
    const f = await fixture();
    const original = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const replacement = randomUUID();
    await database.repository.updateChatExecutionLaneRuntime(
      f.chatId,
      f.bootLaneId,
      replacement,
      "ready",
    );
    const next = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      { ...f.request, threadId: replacement },
    );
    expect(next.id).not.toBe(original.id);
    await database.close();
    database = await connectDatabase(config);
    const recovered = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      {
        ...f.request,
        provenance: { kind: "binding", bindingId: original.id },
      },
    );
    expect(recovered).toEqual(original);
    const current = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      f.chatId,
    );
    expect(current?.threadId).toBe(replacement);
    expect(current?.status).toBe("idle");
    expect(current?.executionLaneId).toBeNull();
  });

  it("rejects an unbound thread and cross-owner/chat/worker binding substitution", async () => {
    const f = await fixture();
    const own = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const other = await fixture();
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...f.request,
        threadId: "invented-thread",
      }),
    ).rejects.toMatchObject({ code: "thread-not-bound" });
    await expect(
      database.repository.nativeHistoryBindings.open("other-owner", f.request),
    ).rejects.toMatchObject({ code: "chat-not-found" });
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...f.request,
        workerId: "unknown-worker",
      }),
    ).rejects.toMatchObject({ code: "worker-not-found" });
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...other.request,
        provenance: { kind: "binding", bindingId: own.id },
      }),
    ).rejects.toMatchObject({ code: "binding-not-found" });
    const apply = vi.fn();
    await expect(
      database.repository.nativeHistoryBindings.withBinding(
        LOCAL_USER_ID,
        workerId,
        other.chatId,
        own.id,
        apply,
      ),
    ).rejects.toMatchObject({ code: "binding-not-found" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("recovers ownership from an exact admitted command after its thread is no longer current", async () => {
    const f = await fixture();
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      f.chatId,
    );
    if (!context || context.contextKind !== "project")
      throw new Error("Missing context");
    const command = nativeCommandAdmissionSchema.parse({
      workerId,
      operationId: randomUUID(),
      origin: "terminal",
      method: "turn/start",
      session: {
        chatId: f.chatId,
        threadId: f.threadId,
        contextKind: "project",
        projectId,
        placementId: context.worktreeId,
        modelRouteId: context.modelRouteId,
        providerAccountId: context.providerAccountId,
        runtimeGeneration: "fixture-runtime",
        connectionId: "fixture-view",
      },
      payloadDigest: "a".repeat(64),
      protectedPayload: envelope,
      expectedActivationGeneration: null,
      intent: { scope: "thread" },
    });
    const accepted = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      command,
    );
    expect(accepted.receipt.status).toBe("accepted");
    await database.repository.nativeCommands.dispatch(LOCAL_USER_ID, {
      workerId,
      operationId: command.operationId,
      operationGeneration: accepted.receipt.operationGeneration,
      payloadDigest: command.payloadDigest,
      session: command.session,
    });
    await database.repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: command.operationId,
      operationGeneration: accepted.receipt.operationGeneration,
      status: "rejected",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: "fixture-failure",
      executionComplete: true,
    });
    const replacement = randomUUID();
    await database.repository.updateChatExecutionLaneRuntime(
      f.chatId,
      f.bootLaneId,
      replacement,
      "ready",
    );
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, f.request),
    ).rejects.toMatchObject({ code: "thread-not-bound" });
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...f.request,
        provenance: {
          kind: "command",
          operationId: command.operationId,
          operationGeneration: "stale",
        },
      }),
    ).rejects.toMatchObject({ code: "command-not-bound" });
    const recovered = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      {
        ...f.request,
        provenance: {
          kind: "command",
          operationId: command.operationId,
          operationGeneration: accepted.receipt.operationGeneration,
        },
      },
    );
    expect(recovered.createdFromOperationId).toBe(command.operationId);
    expect(recovered.threadId).toBe(f.threadId);
    const after = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      f.chatId,
    );
    expect(after?.threadId).toBe(replacement);
    expect(after?.executionLaneId).toBeNull();
  });

  it("does not persist an association after a real database insert failure", async () => {
    const f = await fixture();
    const own = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const replacement = randomUUID();
    await database.repository.updateChatExecutionLaneRuntime(
      f.chatId,
      f.bootLaneId,
      replacement,
      "ready",
    );
    const transact = <T>(
      apply: Parameters<
        typeof database.repository.nativeHistoryBindings.withBinding<T>
      >[4],
    ) =>
      database.repository.nativeHistoryBindings.withBinding(
        LOCAL_USER_ID,
        workerId,
        f.chatId,
        own.id,
        apply,
      );
    await transact(async (tx) => {
      await tx.execute(
        sql`CREATE FUNCTION reject_fixture_history_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture history persistence failure'; END $$`,
      );
      await tx.execute(
        sql`CREATE TRIGGER reject_fixture_history_binding BEFORE INSERT ON native_history_bindings FOR EACH ROW EXECUTE FUNCTION reject_fixture_history_binding()`,
      );
    });
    await expect(
      database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...f.request,
        threadId: replacement,
      }),
    ).rejects.toThrow();
    await transact(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryBindings)
          .where(
            and(
              eq(schema.nativeHistoryBindings.chatId, f.chatId),
              eq(schema.nativeHistoryBindings.threadId, replacement),
            ),
          ),
      ).toEqual([]);
      await tx.execute(
        sql`DROP TRIGGER reject_fixture_history_binding ON native_history_bindings`,
      );
      await tx.execute(sql`DROP FUNCTION reject_fixture_history_binding()`);
    });
    const saved = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      { ...f.request, threadId: replacement },
    );
    expect(saved.threadId).toBe(replacement);
  });

  it("exposes authenticated worker-only opening without native or execution callbacks", async () => {
    const f = await fixture();
    const app = Fastify();
    installInternalNativeHistoryRoutes(app, {
      config,
      repository: database.repository,
      runAsOwner: async (_owner, callback) => callback(),
    });
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: "/api/internal/native-history/open",
        payload: f.request,
      });
      expect(unauthorized.statusCode).toBe(401);
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/native-history/open",
        payload: f.request,
        headers: { authorization: `Bearer ${config.workerToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().binding.threadId).toBe(f.threadId);
      const invalid = await app.inject({
        method: "POST",
        url: "/api/internal/native-history/open",
        payload: { ...f.request, computerUseAuthority: {} },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("native history canonical commit boundary", () => {
  it("rolls back partial canonical writes and returns the original receipt after a lost response", async () => {
    const f = await fixture();
    const binding = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const streamId = randomUUID();
    const input = nativeHistoryIngestSchema.parse({
      workerId,
      chatId: f.chatId,
      bindingId: binding.id,
      streamId,
      sequence: 1,
      recordId: randomUUID(),
      digest: "a".repeat(64),
      previousDigest: null,
      batch: {
        turns: [],
        items: [0, 1].map((index) => {
          const id = randomUUID();
          return {
            identity: {
              threadId: f.threadId,
              turnId: "fixture-turn",
              itemId: `item-${index}`,
              component: "assistant",
              identityKind: "canonical",
            },
            revision: 1,
            state: "completed",
            order: { turn: 0, item: index, component: 0 },
            attachments: [],
            message: {
              id,
              classification: {
                role: "assistant",
                mode: "default",
                attachmentIds: [],
              },
              protectedContent: { formatVersion: 1, keyRevision: 1, envelope },
              reasoningEffort: null,
              idempotencyKey: `history-fixture:${id}`,
            },
          };
        }),
      },
    });
    let fail = true;
    // Exercise actual canonical chat_messages writes inside the supplied DB
    // transaction. Full alias/revision/attachment projection remains separate.
    const apply = vi.fn(async (tx, savedBinding, batch) => {
      for (const item of batch.items) {
        await tx.insert(schema.chatMessages).values({
          id: item.message.id,
          chatId: savedBinding.chatId,
          worktreeId: savedBinding.worktreeId,
          role: item.message.classification.role,
          mode: item.message.classification.mode,
          content: null,
          protectedContent: item.message.protectedContent,
          attachmentIds: [],
          idempotencyKey: item.message.idempotencyKey,
        });
        if (fail) throw new Error("fixture rejected after first message write");
      }
    });
    const inspect = () =>
      database.repository.nativeHistoryBindings.withBinding(
        LOCAL_USER_ID,
        workerId,
        f.chatId,
        binding.id,
        async (tx) => ({
          messages: await tx
            .select()
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.chatId, f.chatId)),
          streams: await tx
            .select()
            .from(schema.nativeHistoryStreams)
            .where(eq(schema.nativeHistoryStreams.bindingId, binding.id)),
          receipts: await tx
            .select()
            .from(schema.nativeHistoryReceipts)
            .where(eq(schema.nativeHistoryReceipts.streamId, streamId)),
          publications: await tx
            .select()
            .from(schema.nativeHistoryPublications)
            .where(eq(schema.nativeHistoryPublications.bindingId, binding.id)),
        }),
      );
    await expect(
      database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        input,
        apply,
      ),
    ).rejects.toThrow("after first message");
    expect(await inspect()).toEqual({
      messages: [],
      streams: [],
      receipts: [],
      publications: [],
    });
    fail = false;
    const committed = await database.repository.nativeHistoryIngestion.commit(
      LOCAL_USER_ID,
      input,
      apply,
    );
    expect(committed).toMatchObject({
      committed: true,
      streamId,
      sequence: 1,
      recordId: input.recordId,
      digest: input.digest,
    });
    const saved = await inspect();
    expect(saved.messages).toHaveLength(2);
    expect(
      saved.messages.every(
        (message) =>
          message.content === null && message.protectedContent !== null,
      ),
    ).toBe(true);
    expect(saved.streams[0]?.acknowledgedSequence).toBe(1);
    expect(saved.receipts).toHaveLength(1);
    expect(saved.publications).toHaveLength(1);
    expect(saved.publications[0]?.commitId).toBe(committed.commitId);
    await database.close();
    database = await connectDatabase(config);
    // No publication ran and the original HTTP response might have been lost.
    expect(
      await database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        input,
        apply,
      ),
    ).toEqual(committed);
    expect(apply).toHaveBeenCalledTimes(2); // one rolled-back write + one commit
    expect((await inspect()).publications).toHaveLength(1);
    expect((await inspect()).messages).toHaveLength(2);

    const altered = structuredClone(input);
    altered.batch.items[0]!.message.protectedContent.envelope.nonce =
      "BBBBBBBBBBBBBBBB";
    await expect(
      database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        altered,
        apply,
      ),
    ).rejects.toMatchObject({ code: "batch-receipt-conflict" });
    await expect(
      database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        { ...input, previousDigest: "b".repeat(64) },
        apply,
      ),
    ).rejects.toMatchObject({ code: "batch-receipt-conflict" });
    await expect(
      database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        { ...input, sequence: 3, previousDigest: input.digest },
        apply,
      ),
    ).rejects.toMatchObject({ code: "batch-sequence-conflict" });
    await expect(
      database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        { ...input, sequence: 2, previousDigest: input.digest },
        apply,
      ),
    ).rejects.toMatchObject({ code: "batch-record-reused" });
    expect(apply).toHaveBeenCalledTimes(2);
    expect((await inspect()).messages).toHaveLength(2);
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      f.chatId,
    );
    expect(context?.executionLaneId).toBeNull();
    expect(context?.status).toBe("idle");
  });

  it("arbitrates simultaneous delivery once and rejects an unrelated thread before applying content", async () => {
    const f = await fixture();
    const binding = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const input = nativeHistoryIngestSchema.parse({
      workerId,
      chatId: f.chatId,
      bindingId: binding.id,
      streamId: randomUUID(),
      sequence: 1,
      recordId: randomUUID(),
      digest: "b".repeat(64),
      previousDigest: null,
      batch: {
        items: [],
        turns: [
          {
            threadId: f.threadId,
            turnId: "turn",
            revision: 1,
            ordinal: 0,
            status: "completed",
            startedAtMs: null,
            completedAtMs: null,
            metadata: envelope,
          },
        ],
      },
    });
    const apply = vi.fn(async () => {});
    const wrongThread = structuredClone(input);
    wrongThread.batch.turns[0]!.threadId = "unrelated";
    await expect(
      database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        wrongThread,
        apply,
      ),
    ).rejects.toMatchObject({ code: "batch-thread-mismatch" });
    expect(apply).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        input,
        apply,
      ),
      database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        input,
        apply,
      ),
    ]);
    expect(first).toEqual(second);
    expect(apply).toHaveBeenCalledOnce();
    await database.repository.nativeHistoryBindings.withBinding(
      LOCAL_USER_ID,
      workerId,
      f.chatId,
      binding.id,
      async (tx) => {
        const turns = await tx
          .select()
          .from(schema.nativeHistoryTurns)
          .where(eq(schema.nativeHistoryTurns.bindingId, binding.id));
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
          turnId: "turn",
          revision: 1,
          status: "completed",
          metadata: envelope,
        });
      },
    );
    await expect(
      database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        { ...input, streamId: randomUUID() },
        apply,
      ),
    ).rejects.toMatchObject({ code: "stream-recovery-required" });
  });

  it("retries failed external publication after database recovery without another input or UI reconnect", async () => {
    const f = await fixture();
    const binding = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const messageId = randomUUID();
    const committed = await database.repository.nativeHistoryIngestion.commit(
      LOCAL_USER_ID,
      nativeHistoryIngestSchema.parse({
        workerId,
        chatId: f.chatId,
        bindingId: binding.id,
        streamId: randomUUID(),
        sequence: 1,
        recordId: randomUUID(),
        digest: "c".repeat(64),
        previousDigest: null,
        batch: { items: [], turns: [] },
      }),
      async (tx, savedBinding) => {
        await tx.insert(schema.chatMessages).values({
          id: messageId,
          chatId: f.chatId,
          worktreeId: savedBinding.worktreeId,
          role: "assistant",
          mode: "default",
          content: null,
          protectedContent: { formatVersion: 1, keyRevision: 1, envelope },
          attachmentIds: [],
          idempotencyKey: `publication-fixture:${messageId}`,
        });
      },
    );
    const external = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture replication unavailable"))
      .mockResolvedValue(undefined);
    const hub = new AppLiveHub({ publishExternal: external });
    const errors = vi.fn();
    const options = {
      intervalMs: 10,
      repository: {
        listPending: async (limit: number) =>
          (
            await database.repository.nativeHistoryPublications.listPending(
              limit,
            )
          ).filter((entry) => entry.commitId === committed.commitId),
        acknowledge: (
          entry: Parameters<
            typeof database.repository.nativeHistoryPublications.acknowledge
          >[0],
        ) => database.repository.nativeHistoryPublications.acknowledge(entry),
        defer: (
          entry: Parameters<
            typeof database.repository.nativeHistoryPublications.defer
          >[0],
          due: Date,
        ) => database.repository.nativeHistoryPublications.defer(entry, due),
      },
      publish: async (entry: {
        ownerId: string;
        chatId: string;
        commitId: string;
      }) => {
        await hub.publishConfirmed({
          ownerId: entry.ownerId,
          scope: { kind: "chat" as const, chatId: entry.chatId },
          resource: "chat-message" as const,
          action: "invalidated" as const,
          entityId: entry.commitId,
          revision: null,
          payload: null,
        });
      },
      onError: errors,
    };
    const first = createNativeHistoryPublicationDelivery(options);
    let recovered:
      ReturnType<typeof createNativeHistoryPublicationDelivery> | undefined;
    try {
      const [entry] = await options.repository.listPending(64);
      if (!entry) throw new Error("Missing committed publication");
      expect(
        await database.repository.nativeHistoryPublications.acknowledge({
          ...entry,
          ownerId: "unrelated-owner",
        }),
      ).toBe(false);
      await first.runOnce();
      expect(errors).toHaveBeenCalledOnce();
      expect(external).toHaveBeenCalledOnce();
      await database.repository.nativeHistoryBindings.withBinding(
        LOCAL_USER_ID,
        workerId,
        f.chatId,
        binding.id,
        async (tx) => {
          const [pending] = await tx
            .select()
            .from(schema.nativeHistoryPublications)
            .where(
              eq(schema.nativeHistoryPublications.commitId, committed.commitId),
            );
          expect(pending?.attempts).toBe(1);
          expect(pending!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
          expect(
            await tx
              .select()
              .from(schema.nativeHistoryReceipts)
              .where(
                eq(schema.nativeHistoryReceipts.commitId, committed.commitId),
              ),
          ).toHaveLength(1);
        },
      );
      first.stop();
      await database.close();
      database = await connectDatabase(config);
      recovered = createNativeHistoryPublicationDelivery(options);
      recovered.start();
      await vi.waitFor(
        async () => {
          const remaining =
            await database.repository.nativeHistoryBindings.withBinding(
              LOCAL_USER_ID,
              workerId,
              f.chatId,
              binding.id,
              (tx) =>
                tx
                  .select()
                  .from(schema.nativeHistoryPublications)
                  .where(
                    eq(
                      schema.nativeHistoryPublications.commitId,
                      committed.commitId,
                    ),
                  ),
            );
          expect(remaining).toEqual([]);
        },
        { timeout: 3_000, interval: 20 },
      );
      expect(external).toHaveBeenCalledTimes(2);
      expect(hub.stats().publicationCount).toBe(2);
      await database.repository.nativeHistoryBindings.withBinding(
        LOCAL_USER_ID,
        workerId,
        f.chatId,
        binding.id,
        async (tx) => {
          expect(
            await tx
              .select()
              .from(schema.chatMessages)
              .where(eq(schema.chatMessages.chatId, f.chatId)),
          ).toHaveLength(1);
          expect(
            await tx
              .select()
              .from(schema.nativeHistoryReceipts)
              .where(
                eq(schema.nativeHistoryReceipts.commitId, committed.commitId),
              ),
          ).toHaveLength(1);
        },
      );
    } finally {
      first.stop();
      recovered?.stop();
      hub.close();
    }
  });
});

describe("durable historical turn projection", () => {
  it("starts publication from application readiness and preserves an in-flight row across real shutdown", async () => {
    const f = await turnFixture();
    const committed = await f.submit();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const external = vi.fn(() => held);
    const firstHub = new AppLiveHub({ publishExternal: external });
    const firstApp = Fastify();
    const acknowledge = vi.fn((entry) =>
      database.repository.nativeHistoryPublications.acknowledge(entry),
    );
    const dependencies = () => ({
      config,
      repository: {
        nativeHistoryBindings: database.repository.nativeHistoryBindings,
        nativeHistoryItems: database.repository.nativeHistoryItems,
        nativeHistoryIngestion: database.repository.nativeHistoryIngestion,
        authenticateWorkerCredential:
          database.repository.authenticateWorkerCredential.bind(
            database.repository,
          ),
        nativeHistoryPublications: {
          listPending: async (limit: number) =>
            (
              await database.repository.nativeHistoryPublications.listPending(
                limit,
              )
            ).filter((entry) => entry.commitId === committed.commitId),
          acknowledge,
          defer: (
            entry: Parameters<
              typeof database.repository.nativeHistoryPublications.defer
            >[0],
            due: Date,
          ) => database.repository.nativeHistoryPublications.defer(entry, due),
        },
      },
      runAsOwner: async <T>(_owner: string, callback: () => Promise<T>) =>
        callback(),
    });
    const first = installNativeHistoryRuntime(
      firstApp,
      firstHub,
      dependencies(),
    );
    let closed = false;
    firstApp.addHook("onClose", async () => {
      firstHub.close();
      await database.close();
      closed = true;
    });
    try {
      await firstApp.ready();
      await vi.waitFor(() => expect(external).toHaveBeenCalledOnce());
      // The real preClose hook must stop delivery before onClose shuts the DB.
      // Shutdown must also finish without waiting for the held external fanout.
      await firstApp.close();
      expect(closed).toBe(true);
      release();
      await first.runOnce();
      expect(acknowledge).not.toHaveBeenCalled();
    } finally {
      release();
      await firstApp.close();
      firstHub.close();
      database = await connectDatabase(config);
    }
    const pending =
      await database.repository.nativeHistoryPublications.listPending(64);
    expect(pending.some((entry) => entry.commitId === committed.commitId)).toBe(
      true,
    );
    const recoveredHub = new AppLiveHub({ publishExternal: async () => {} });
    const recoveredApp = Fastify();
    installNativeHistoryRuntime(recoveredApp, recoveredHub, dependencies());
    try {
      await recoveredApp.ready();
      await vi.waitFor(async () => {
        expect(acknowledge).toHaveBeenCalledOnce();
        const rows =
          await database.repository.nativeHistoryPublications.listPending(64);
        expect(
          rows.some((entry) => entry.commitId === committed.commitId),
        ).toBe(false);
      });
      expect((await f.inspect()).receipts).toHaveLength(1);
    } finally {
      await recoveredApp.close();
      recoveredHub.close();
    }
  });

  it("round trips actual worker-encrypted metadata through canonical storage and database restart", async () => {
    const f = await fixture();
    const binding = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const service = {
      ownerId: () => LOCAL_USER_ID,
      serverIdentity: () => "history-fixture-server",
      componentKey: (_scope: string, keyRevision = 1) => {
        if (keyRevision !== 1)
          throw new Error("Unexpected fixture key revision");
        return { key: new Uint8Array(32).fill(37), keyRevision };
      },
    };
    const snapshot = parseCodexNativeHistory(
      {
        thread: {
          id: f.threadId,
          parentThreadId: null,
          forkedFromId: null,
          status: { type: "idle" },
          turns: [
            {
              id: "encrypted-turn",
              status: "completed",
              items: [],
              itemsView: "full",
              startedAt: 1_788_000_000,
              completedAt: 1_788_000_001,
              durationMs: 920,
              retainedPrivateField: "private historical evidence",
            },
          ],
        },
        history: null,
      },
      f.threadId,
    );
    const prepared = await prepareNativeHistoryTurn({
      service,
      binding,
      snapshot,
      turnId: "encrypted-turn",
      revision: 1,
    });
    const input = nativeHistoryIngestSchema.parse({
      workerId,
      chatId: f.chatId,
      bindingId: binding.id,
      streamId: randomUUID(),
      sequence: 1,
      recordId: randomUUID(),
      digest: "f".repeat(64),
      previousDigest: null,
      batch: { items: [], turns: [prepared] },
    });
    const receipt = await database.repository.nativeHistoryIngestion.commit(
      LOCAL_USER_ID,
      input,
      async () => {},
    );
    await database.close();
    database = await connectDatabase(config);
    const restored =
      await database.repository.nativeHistoryBindings.withBinding(
        LOCAL_USER_ID,
        workerId,
        f.chatId,
        binding.id,
        async (tx) => {
          const rows = await tx
            .select()
            .from(schema.nativeHistoryTurns)
            .where(eq(schema.nativeHistoryTurns.bindingId, binding.id));
          expect(rows).toHaveLength(1);
          expect(JSON.stringify(rows)).not.toContain(
            "private historical evidence",
          );
          const {
            bindingId: _bindingId,
            payloadDigest: _digest,
            usage,
            modelAttribution: _enrichedAttribution,
            capturedModelAttribution,
            ...row
          } = rows[0]!;
          return {
            ...row,
            threadId: binding.threadId,
            ...(usage == null ? {} : { usage }),
            ...(capturedModelAttribution == null
              ? {}
              : { modelAttribution: capturedModelAttribution }),
          };
        },
      );
    expect(restored).toEqual(prepared);
    expect(
      await openNativeHistoryTurn({ service, binding, turn: restored }),
    ).toMatchObject({
      nativeTurn: {
        retainedPrivateField: "private historical evidence",
        durationMs: 920,
      },
      history: null,
    });
    expect(
      await database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        input,
        async () => {
          throw new Error("Committed replay must not apply again");
        },
      ),
    ).toEqual(receipt);
  });

  async function turnFixture() {
    const f = await fixture();
    const binding = await database.repository.nativeHistoryBindings.open(
      LOCAL_USER_ID,
      f.request,
    );
    const streamId = randomUUID();
    let sequence = 1;
    let previousDigest: string | null = null;
    const turn: NativeHistoryTurn = {
      threadId: f.threadId,
      turnId: "same-native-turn",
      revision: 1,
      ordinal: 0,
      status: "completed",
      startedAtMs: null,
      completedAtMs: null,
      metadata: envelope,
    };
    const submit = async (changes: Partial<NativeHistoryTurn> = {}) => {
      const input = nativeHistoryIngestSchema.parse({
        workerId,
        chatId: f.chatId,
        bindingId: binding.id,
        streamId,
        sequence,
        previousDigest,
        recordId: randomUUID(),
        digest: createHash("sha256")
          .update(`${streamId}:${sequence}`)
          .digest("hex"),
        batch: { items: [], turns: [{ ...turn, ...changes }] },
      });
      const receipt = await database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        input,
        async () => {},
      );
      sequence++;
      previousDigest = receipt.digest;
      return receipt;
    };
    const inspect = () =>
      database.repository.nativeHistoryBindings.withBinding(
        LOCAL_USER_ID,
        workerId,
        f.chatId,
        binding.id,
        async (tx) => ({
          turns: await tx
            .select()
            .from(schema.nativeHistoryTurns)
            .where(eq(schema.nativeHistoryTurns.bindingId, binding.id)),
          streams: await tx
            .select()
            .from(schema.nativeHistoryStreams)
            .where(eq(schema.nativeHistoryStreams.bindingId, binding.id)),
          receipts: await tx
            .select()
            .from(schema.nativeHistoryReceipts)
            .where(eq(schema.nativeHistoryReceipts.streamId, streamId)),
        }),
      );
    return { ...f, binding, streamId, turn, submit, inspect };
  }

  it("retains terminal evidence through stale snapshots, restart, and late metadata enrichment", async () => {
    const f = await turnFixture();
    await f.submit({ revision: 4 });
    const initial = (await f.inspect()).turns[0]!;
    expect(initial.startedAtMs).toBeNull();
    expect(initial.completedAtMs).toBeNull();
    await f.submit({ revision: 2, status: "inProgress", startedAtMs: 100 });
    await f.submit({ revision: 5, status: "inProgress", startedAtMs: 200 });
    expect((await f.inspect()).turns).toEqual([initial]);
    await database.close();
    database = await connectDatabase(config);
    expect((await f.inspect()).turns).toEqual([initial]);
    const metadata = { ...envelope, nonce: "BBBBBBBBBBBBBBBB" };
    await f.submit({
      revision: 6,
      ordinal: 2,
      startedAtMs: 100,
      completedAtMs: 750,
      metadata,
    });
    const saved = await f.inspect();
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0]).toMatchObject({
      revision: 6,
      ordinal: 2,
      status: "completed",
      startedAtMs: 100,
      completedAtMs: 750,
      metadata,
    });
    expect(saved.streams[0]?.acknowledgedSequence).toBe(4);
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      f.chatId,
    );
    expect(context?.executionLaneId).toBeNull();
    expect(context?.status).toBe("idle");
  });

  it("rejects conflicting content at the same revision atomically and permits the exact revision again", async () => {
    const f = await turnFixture();
    await f.submit();
    const before = await f.inspect();
    await expect(f.submit({ status: "failed" })).rejects.toMatchObject({
      code: "turn-revision-conflict",
    });
    expect(await f.inspect()).toEqual(before);
    const reversedMetadata = Object.fromEntries(
      Object.entries(envelope).reverse(),
    ) as typeof envelope;
    await f.submit({ metadata: reversedMetadata });
    const after = await f.inspect();
    expect(after.turns).toEqual(before.turns);
    expect(after.receipts).toHaveLength(2);
    expect(after.streams[0]?.acknowledgedSequence).toBe(2);
  });

  it("keeps a replacement's copied turn outcome separate from the original thread", async () => {
    const f = await turnFixture();
    await f.submit({ status: "completed", revision: 5 });
    const original = (await f.inspect()).turns[0]!;
    const replacement = randomUUID();
    await database.repository.updateChatExecutionLaneRuntime(
      f.chatId,
      f.bootLaneId,
      replacement,
      "ready",
    );
    const replacementBinding =
      await database.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
        ...f.request,
        threadId: replacement,
      });
    await database.repository.nativeHistoryIngestion.commit(
      LOCAL_USER_ID,
      nativeHistoryIngestSchema.parse({
        workerId,
        chatId: f.chatId,
        bindingId: replacementBinding.id,
        streamId: randomUUID(),
        sequence: 1,
        previousDigest: null,
        recordId: randomUUID(),
        digest: "d".repeat(64),
        batch: {
          items: [],
          turns: [
            {
              ...f.turn,
              threadId: replacement,
              revision: 100,
              status: "interrupted",
            },
          ],
        },
      }),
      async () => {},
    );
    expect((await f.inspect()).turns).toEqual([original]);
    await database.repository.nativeHistoryBindings.withBinding(
      LOCAL_USER_ID,
      workerId,
      f.chatId,
      replacementBinding.id,
      async (tx) => {
        const turns = await tx
          .select()
          .from(schema.nativeHistoryTurns)
          .where(
            eq(schema.nativeHistoryTurns.bindingId, replacementBinding.id),
          );
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
          turnId: f.turn.turnId,
          status: "interrupted",
          revision: 100,
        });
      },
    );
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      f.chatId,
    );
    expect(context?.threadId).toBe(replacement);
    expect(context?.executionLaneId).toBeNull();
    expect(context?.status).toBe("idle");
  });

  it("rolls back prior canonical writes when real turn storage fails and commits the repaired retry", async () => {
    const f = await turnFixture();
    const transact = <T>(
      apply: Parameters<
        typeof database.repository.nativeHistoryBindings.withBinding<T>
      >[4],
    ) =>
      database.repository.nativeHistoryBindings.withBinding(
        LOCAL_USER_ID,
        workerId,
        f.chatId,
        f.binding.id,
        apply,
      );
    await transact(async (tx) => {
      await tx.execute(
        sql`CREATE FUNCTION reject_fixture_history_turn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture turn persistence failure'; END $$`,
      );
      await tx.execute(
        sql`CREATE TRIGGER reject_fixture_history_turn AFTER INSERT ON native_history_turns FOR EACH ROW EXECUTE FUNCTION reject_fixture_history_turn()`,
      );
    });
    const input = nativeHistoryIngestSchema.parse({
      workerId,
      chatId: f.chatId,
      bindingId: f.binding.id,
      streamId: f.streamId,
      sequence: 1,
      recordId: randomUUID(),
      digest: "e".repeat(64),
      previousDigest: null,
      batch: { items: [], turns: [f.turn] },
    });
    const messageId = randomUUID();
    const apply: Parameters<
      typeof database.repository.nativeHistoryIngestion.commit
    >[2] = async (tx, binding) => {
      await tx.insert(schema.chatMessages).values({
        id: messageId,
        chatId: binding.chatId,
        worktreeId: binding.worktreeId,
        role: "assistant",
        mode: "default",
        content: null,
        protectedContent: { formatVersion: 1, keyRevision: 1, envelope },
        attachmentIds: [],
        idempotencyKey: `turn-transaction:${messageId}`,
      });
    };
    try {
      await expect(
        database.repository.nativeHistoryIngestion.commit(
          LOCAL_USER_ID,
          input,
          apply,
        ),
      ).rejects.toThrow();
      expect(await f.inspect()).toEqual({
        turns: [],
        streams: [],
        receipts: [],
      });
      await transact(async (tx) => {
        expect(
          await tx
            .select()
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.chatId, f.chatId)),
        ).toEqual([]);
        expect(
          await tx
            .select()
            .from(schema.nativeHistoryPublications)
            .where(
              eq(schema.nativeHistoryPublications.bindingId, f.binding.id),
            ),
        ).toEqual([]);
      });
    } finally {
      await transact(async (tx) => {
        await tx.execute(
          sql`DROP TRIGGER reject_fixture_history_turn ON native_history_turns`,
        );
        await tx.execute(sql`DROP FUNCTION reject_fixture_history_turn()`);
      });
    }
    const receipt = await database.repository.nativeHistoryIngestion.commit(
      LOCAL_USER_ID,
      input,
      apply,
    );
    expect(
      await database.repository.nativeHistoryIngestion.commit(
        LOCAL_USER_ID,
        input,
        apply,
      ),
    ).toEqual(receipt);
    const saved = await f.inspect();
    expect(saved.turns).toHaveLength(1);
    expect(saved.receipts).toHaveLength(1);
    await transact(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, f.chatId)),
      ).toHaveLength(1);
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryPublications)
          .where(eq(schema.nativeHistoryPublications.bindingId, f.binding.id)),
      ).toHaveLength(1);
    });
  });
});
