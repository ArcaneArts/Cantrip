import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nativeCommandAdmissionSchema,
  nativeHistoryIngestSchema,
  nativeHistoryResolveSchema,
  queuedPromptOpaqueContentSchema,
  type ManagedQueueClaim,
  type NativeCommandAdmission,
  type NativeHistoryBinding,
  type NativeHistoryResolve,
  type NativeHistoryPreparedBatch,
  type NativeHistoryItemMapping,
} from "@cantrip/protocol";
import * as schema from "../src/db/schema.js";
import { createNativeCommandWorkerFixture } from "./native-command-worker-fixture.js";
import {
  EncryptedChatEventSealer,
  openEncryptedChatTurn,
} from "../../cantrip_worker/src/chat-message-encryption.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import {
  protectNativeHistoryItemEvidence,
  openNativeHistoryItemEvidence,
} from "../../cantrip_worker/src/native-history-item-content.js";
import type { NativeHistoryStateItem } from "../../cantrip_worker/src/native-history-state.js";

let f: Awaited<ReturnType<typeof createNativeCommandWorkerFixture>>;
let binding: NativeHistoryBinding;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-native-history-items-"),
  );
  f = await createNativeCommandWorkerFixture({
    cwd: directory,
    modelBaseUrl: "http://127.0.0.1:1/v1",
  });
  const threadId = randomUUID();
  await f.bindThread(threadId);
  binding = await f.repository.nativeHistoryBindings.open(f.ownerId, {
    workerId: f.workerId,
    chatId: f.chatId,
    threadId,
    provenance: { kind: "current" },
  });
}, 60_000);
afterEach(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});

const envelope = {
  version: 1 as const,
  algorithm: "AES-256-GCM" as const,
  keyRevision: 1,
  nonce: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
};
const identity = (itemId = "item", turnId = "turn") => ({
  threadId: binding.threadId,
  turnId,
  itemId,
  component: "user",
  identityKind: "canonical" as const,
});
const request = (items: NativeHistoryResolve["items"]) =>
  nativeHistoryResolveSchema.parse({
    workerId: f.workerId,
    chatId: f.chatId,
    bindingId: binding.id,
    items,
  });
const observedInput = (
  item: NativeHistoryResolve["items"][number],
): NativeHistoryResolve["items"][number] => {
  if (!("clientUserMessageId" in item.association))
    throw new Error("Fixture requires a client input identity");
  return {
    identity: item.identity,
    association: {
      kind: "observed-input",
      clientUserMessageId: item.association.clientUserMessageId,
    },
  };
};
const transact = <T>(
  apply: Parameters<
    typeof f.repository.nativeHistoryBindings.withBinding<T>
  >[4],
) =>
  f.repository.nativeHistoryBindings.withBinding(
    f.ownerId,
    f.workerId,
    f.chatId,
    binding.id,
    apply,
  );

async function guiInput() {
  const messageId = randomUUID();
  const message = {
    id: messageId,
    classification: {
      role: "user" as const,
      mode: "default" as const,
      attachmentIds: ["original-image-id"],
    },
    protectedContent: { formatVersion: 1 as const, keyRevision: 1, envelope },
    reasoningEffort: null,
    idempotencyKey: `original:${messageId}`,
  };
  await transact(async (tx) => {
    await tx
      .insert(schema.chatAttachments)
      .values({
        id: "original-image-id",
        chatId: binding.chatId,
        workerId: binding.workerId,
        protectedMetadata: { formatVersion: 1, keyRevision: 1, envelope },
        sizeBytes: 10,
        status: "ready",
      })
      .onConflictDoNothing();
  });
  expect(
    await f.repository.appendEncryptedMessage(f.ownerId, f.chatId, message),
  ).not.toBeNull();
  const input = nativeCommandAdmissionSchema.parse({
    workerId: f.workerId,
    operationId: randomUUID(),
    origin: "gui",
    method: "turn/start",
    session: {
      chatId: f.chatId,
      threadId: binding.threadId,
      contextKind: "project",
      projectId: f.projectId,
      placementId: binding.worktreeId,
      modelRouteId: binding.modelRouteId,
      providerAccountId: binding.providerAccountId,
      runtimeGeneration: randomUUID(),
      connectionId: "fixture-gui",
    },
    payloadDigest: "a".repeat(64),
    protectedPayload: envelope,
    expectedActivationGeneration: null,
    intent: { scope: "thread" },
  });
  const grant = await f.repository.nativeCommands.admit(f.ownerId, input, {
    clientMessageId: messageId,
  });
  expect(grant.receipt.status).toBe("accepted");
  await f.repository.nativeCommands.dispatch(f.ownerId, {
    workerId: f.workerId,
    operationId: input.operationId,
    operationGeneration: grant.receipt.operationGeneration,
    payloadDigest: input.payloadDigest,
    session: input.session,
  });
  const turnId = randomUUID();
  const observe = (complete = false) =>
    f.repository.nativeCommands.settle(f.ownerId, {
      workerId: f.workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      resultDigest: "b".repeat(64),
      protectedResult: envelope,
      rejectionCode: null,
      executionComplete: complete,
      reconciliation: {
        nativeTurnId: turnId,
        runtimeGeneration: input.session.runtimeGeneration!,
      },
    });
  const item = {
    identity: identity(randomUUID(), turnId),
    association: {
      kind: "command-input" as const,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      clientUserMessageId: `cantrip:${messageId}`,
    },
  };
  return { message, input, grant, turnId, observe, item };
}

async function guiSteer() {
  const root = await guiInput();
  await root.observe();
  const messageId = randomUUID();
  const message = {
    ...root.message,
    id: messageId,
    idempotencyKey: `steer:${messageId}`,
  };
  await f.repository.appendEncryptedMessage(f.ownerId, f.chatId, message);
  const input = nativeCommandAdmissionSchema.parse({
    ...root.input,
    operationId: randomUUID(),
    method: "turn/steer",
    payloadDigest: "c".repeat(64),
    expectedActivationGeneration: root.grant.receipt.activationGeneration,
    intent: { scope: "thread", expectedTurnId: root.turnId },
  });
  const grant = await f.repository.nativeCommands.admit(f.ownerId, input, {
    clientMessageId: messageId,
  });
  expect(grant.receipt.status).toBe("accepted");
  await f.repository.nativeCommands.dispatch(f.ownerId, {
    workerId: f.workerId,
    operationId: input.operationId,
    operationGeneration: grant.receipt.operationGeneration,
    payloadDigest: input.payloadDigest,
    session: input.session,
  });
  const acknowledge = () =>
    f.repository.nativeCommands.settle(f.ownerId, {
      workerId: f.workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      resultDigest: "d".repeat(64),
      protectedResult: envelope,
      rejectionCode: null,
      executionComplete: false,
    });
  const item = {
    identity: identity(randomUUID(), root.turnId),
    association: {
      kind: "command-input" as const,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      clientUserMessageId: `cantrip:${messageId}`,
    },
  };
  return { root, message, input, grant, item, acknowledge };
}

describe("canonical native item identity reservations", () => {
  it("selects direct start and steering provenance from observed client IDs and actual historical turns", async () => {
    const root = await guiInput();
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([observedInput(root.item)]),
      ),
    ).rejects.toMatchObject({ code: "input-provenance-unobserved" });
    await root.observe(true);
    const [mapping] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([observedInput(root.item)]),
    );
    expect(mapping?.preservedInput).toEqual(root.message);
    const steer = await guiSteer();
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([observedInput(steer.item)]),
      ),
    ).rejects.toMatchObject({ code: "input-command-unacknowledged" });
    await steer.acknowledge();
    await steer.root.observe(true);
    const replacement = await guiInput();
    await replacement.observe();
    const [steered] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([observedInput(steer.item)]),
    );
    expect(steered?.preservedInput).toEqual(steer.message);
    expect(
      await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([steer.item]),
      ),
    ).toEqual([steered]);
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          {
            ...observedInput(steer.item),
            identity: { ...steer.item.identity, turnId: replacement.turnId },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "input-provenance-turn-mismatch" });
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          {
            identity: identity(),
            association: {
              kind: "observed-input",
              clientUserMessageId: `cantrip:${randomUUID()}`,
            },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "input-provenance-unavailable" });
    const [native] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([
        {
          identity: identity("unmanaged"),
          association: {
            kind: "observed-input",
            clientUserMessageId: "native-client-id",
          },
        },
      ]),
    );
    expect(native?.preservedInput).toBeNull();
  });

  it("recovers reserved GUI aliases without creating a mapping or requiring retired command provenance again", async () => {
    const command = await guiInput();
    await command.observe(true);
    const [reserved] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([command.item]),
    );
    const lookup = {
      identity: command.item.identity,
      association: { kind: "existing" as const },
    };
    expect(
      await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([lookup]),
      ),
    ).toEqual([reserved]);
    expect(reserved?.preservedInput).toEqual(command.message);
    const otherWorkerId = randomUUID();
    const otherBindingId = randomUUID();
    await transact(async (tx) => {
      const [worker] = await tx
        .select()
        .from(schema.workers)
        .where(eq(schema.workers.id, f.workerId));
      await tx.insert(schema.workers).values({ ...worker!, id: otherWorkerId });
      // Isolated fixture of an already authorized historical migration binding.
      await tx.insert(schema.nativeHistoryBindings).values({
        ...binding,
        id: otherBindingId,
        workerId: otherWorkerId,
        ownerId: f.ownerId,
        createdAt: new Date(binding.createdAt),
      });
    });
    const migrated = {
      ...request([lookup]),
      workerId: otherWorkerId,
      bindingId: otherBindingId,
    };
    expect(
      await f.repository.nativeHistoryItems.resolve(f.ownerId, migrated),
    ).toEqual([reserved]);
    expect(
      await f.repository.nativeHistoryItems.resolve(f.ownerId, {
        ...migrated,
        items: [command.item],
      }),
    ).toEqual([reserved]);
    expect(
      await f.repository.nativeHistoryItems.resolve(f.ownerId, {
        ...migrated,
        items: [observedInput(command.item)],
      }),
    ).toEqual([reserved]);
    await expect(
      f.repository.nativeHistoryItems.resolve(randomUUID(), migrated),
    ).rejects.toMatchObject({ code: "chat-not-found" });
    // First-time recovery also uses the historical command, even though that
    // command was executed by the original worker and has no reservation yet.
    const unreserved = await guiInput();
    await unreserved.observe(true);
    const [recoveredInput] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      {
        ...migrated,
        items: [observedInput(unreserved.item)],
      },
    );
    expect(recoveredInput?.preservedInput).toEqual(unreserved.message);
    const before = await f.repository.getChatExecutionContext(
      f.ownerId,
      f.chatId,
    );
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          { ...lookup, identity: { ...lookup.identity, itemId: randomUUID() } },
        ]),
      ),
    ).rejects.toMatchObject({ code: "item-not-reserved", statusCode: 404 });
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          {
            ...lookup,
            identity: { ...lookup.identity, threadId: randomUUID() },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "item-thread-mismatch" });
    // The native namespace cannot silently reclassify a previously aliased item.
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([{ ...lookup, association: { kind: "native" } }]),
      ),
    ).rejects.toMatchObject({ code: "item-association-conflict" });
    expect(
      await f.repository.getChatExecutionContext(f.ownerId, f.chatId),
    ).toEqual(before);
    expect(
      await transact((tx) => tx.select().from(schema.nativeHistoryItems)),
    ).toHaveLength(2);
  });

  it("preserves direct GUI steering input only after acknowledgment and across replacement activations", async () => {
    const steer = await guiSteer();
    await expect(
      f.repository.nativeHistoryItems.resolve(f.ownerId, request([steer.item])),
    ).rejects.toMatchObject({ code: "input-command-unacknowledged" });
    await steer.acknowledge();
    await steer.root.observe(true);
    const replacement = await guiInput();
    await replacement.observe();
    const before = await f.repository.getChatExecutionContext(
      f.ownerId,
      f.chatId,
    );
    const [mapping] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([steer.item]),
    );
    expect(mapping).toMatchObject({
      messageId: steer.message.id,
      preservedInput: steer.message,
    });
    await f.repository.nativeHistoryIngestion.ingest(
      f.ownerId,
      ingestInput([preparedItem(mapping!)]),
    );
    expect(
      await f.repository.getChatExecutionContext(f.ownerId, f.chatId),
    ).toEqual(before);
    expect(
      await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([steer.item]),
      ),
    ).toEqual([mapping]);
    await transact(async (tx) => {
      const turns = await tx.select().from(schema.nativeCommandTurns);
      expect(turns.map((turn) => turn.operationId)).not.toContain(
        steer.input.operationId,
      );
      const [saved] = await tx
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, steer.message.id));
      expect(saved?.protectedContent).toEqual(steer.message.protectedContent);
      expect(saved?.attachmentIds).toEqual(["original-image-id"]);
    });
  });

  it("rejects a direct steer alias for another turn, client input or runtime", async () => {
    const steer = await guiSteer();
    await steer.acknowledge();
    for (const [changed, code] of [
      [
        {
          ...steer.item,
          identity: { ...steer.item.identity, turnId: randomUUID() },
        },
        "input-command-turn-mismatch",
      ],
      [
        {
          ...steer.item,
          association: {
            ...steer.item.association,
            clientUserMessageId: `cantrip:${steer.root.message.id}`,
          },
        },
        "input-client-id-mismatch",
      ],
    ] as const) {
      await expect(
        f.repository.nativeHistoryItems.resolve(f.ownerId, request([changed])),
      ).rejects.toMatchObject({ code });
    }
    // Corrupt only the isolated fixture's historical generation. An association
    // must not silently borrow a different runtime's root turn.
    await transact((tx) =>
      tx
        .update(schema.nativeCommands)
        .set({
          identity: { ...steer.input.session, runtimeGeneration: randomUUID() },
        })
        .where(eq(schema.nativeCommands.operationId, steer.input.operationId)),
    );
    await expect(
      f.repository.nativeHistoryItems.resolve(f.ownerId, request([steer.item])),
    ).rejects.toMatchObject({ code: "input-command-turn-mismatch" });
    expect(
      await transact((tx) => tx.select().from(schema.nativeHistoryItems)),
    ).toEqual([]);
  });

  it("reserves concurrent native identities once without writing messages or acknowledging ingestion", async () => {
    const input = request([
      { identity: identity("same-item"), association: { kind: "native" } },
      {
        identity: { ...identity("same-item"), identityKind: "legacy" },
        association: { kind: "native" },
      },
      {
        identity: { ...identity("same-item"), component: "activity" },
        association: { kind: "native" },
      },
    ]);
    const [a, b] = await Promise.all([
      f.repository.nativeHistoryItems.resolve(f.ownerId, input),
      f.repository.nativeHistoryItems.resolve(f.ownerId, input),
    ]);
    expect(a).toEqual(b);
    expect(new Set(a.map((item) => item.messageId)).size).toBe(3);
    expect(a.every((item) => item.preservedInput === null)).toBe(true);
    await transact(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryItems)
          .where(eq(schema.nativeHistoryItems.chatId, f.chatId)),
      ).toHaveLength(3);
      expect(
        await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, f.chatId)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryStreams)
          .where(eq(schema.nativeHistoryStreams.bindingId, binding.id)),
      ).toEqual([]);
    });
  });

  it("requires observed command/turn evidence and preserves the original protected GUI input", async () => {
    const command = await guiInput();
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([command.item]),
      ),
    ).rejects.toMatchObject({ code: "input-command-turn-unobserved" });
    await command.observe();
    const [mapped] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([command.item]),
    );
    expect(mapped).toMatchObject({
      messageId: command.message.id,
      idempotencyKey: command.message.idempotencyKey,
      preservedInput: command.message,
    });
    expect(
      await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([command.item]),
      ),
    ).toEqual([mapped]);
    await transact(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.chatId, f.chatId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attachmentIds).toEqual(["original-image-id"]);
      expect(rows[0]?.protectedContent).toEqual(
        command.message.protectedContent,
      );
    });
  });

  it("rejects a forged prefix, wrong turn/generation, and a second item claiming the same input", async () => {
    const command = await guiInput();
    await command.observe();
    for (const [item, code] of [
      [
        {
          ...command.item,
          association: {
            ...command.item.association,
            operationGeneration: "old",
          },
        },
        "input-command-not-bound",
      ],
      [
        {
          ...command.item,
          association: {
            ...command.item.association,
            clientUserMessageId: `cantrip:${randomUUID()}`,
          },
        },
        "input-client-id-mismatch",
      ],
      [
        {
          ...command.item,
          identity: { ...command.item.identity, turnId: randomUUID() },
        },
        "input-command-turn-mismatch",
      ],
      [
        {
          ...command.item,
          identity: { ...command.item.identity, component: "assistant" },
        },
        "input-alias-component-mismatch",
      ],
    ] as const) {
      await expect(
        f.repository.nativeHistoryItems.resolve(f.ownerId, request([item])),
      ).rejects.toMatchObject({ code });
    }
    await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([command.item]),
    );
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          {
            ...command.item,
            identity: { ...command.item.identity, itemId: "second-item" },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "input-alias-already-claimed" });
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          { identity: command.item.identity, association: { kind: "native" } },
        ]),
      ),
    ).rejects.toMatchObject({ code: "item-association-conflict" });
    await transact(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryItems)
          .where(eq(schema.nativeHistoryItems.chatId, f.chatId)),
      ).toHaveLength(1);
    });
  });

  it("keeps an ended command's native identity after the next activation replaces it", async () => {
    const first = await guiInput();
    await first.observe(true);
    const [original] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([first.item]),
    );
    const next = await guiInput();
    await next.observe();
    await transact(async (tx) => {
      const [active] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, f.chatId));
      expect(active?.operationId).toBe(next.input.operationId);
      const turns = await tx
        .select()
        .from(schema.nativeCommandTurns)
        .where(eq(schema.nativeCommandTurns.chatId, f.chatId));
      expect(turns).toHaveLength(2);
    });
    expect(
      await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([first.item]),
      ),
    ).toEqual([original]);
    const [second] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([next.item]),
    );
    expect(second?.messageId).toBe(next.message.id);
    expect(second?.messageId).not.toBe(original?.messageId);
  });

  it.each(["terminal", "native-terminal"] as const)(
    "recovers an older %s receipt without changing execution state",
    async (kind) => {
      const command = await guiInput();
      await command.observe(true);
      const before = await transact(async (tx) => {
        // Simulate the pre-index database shape while retaining the exact native
        // turn/runtime receipt that the previous settlement code persisted.
        await tx
          .delete(schema.nativeCommandTurns)
          .where(
            eq(
              schema.nativeCommandTurns.operationId,
              command.input.operationId,
            ),
          );
        if (kind === "native-terminal")
          await tx
            .update(schema.nativeCommands)
            .set({
              terminalEvidence: {
                kind,
                retryReason: "invalid-compaction",
                nativeTurnId: command.turnId,
                runtimeGeneration: command.input.session.runtimeGeneration,
              },
            })
            .where(
              eq(schema.nativeCommands.operationId, command.input.operationId),
            );
        return tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, f.chatId));
      });
      const [mapping] = await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([command.item]),
      );
      expect(mapping?.preservedInput).toEqual(command.message);
      await transact(async (tx) => {
        expect(
          await tx
            .select()
            .from(schema.nativeCommandTurns)
            .where(
              eq(
                schema.nativeCommandTurns.operationId,
                command.input.operationId,
              ),
            ),
        ).toMatchObject([
          {
            operationId: command.input.operationId,
            turnId: command.turnId,
            runtimeGeneration: command.input.session.runtimeGeneration,
          },
        ]);
        expect(
          await tx
            .select()
            .from(schema.nativeCommandActivations)
            .where(eq(schema.nativeCommandActivations.chatId, f.chatId)),
        ).toEqual(before);
      });
    },
  );

  it("does not recover history ownership from declined, incomplete, malformed or wrong-runtime receipts", async () => {
    const command = await guiInput();
    await command.observe(true);
    await transact(async (tx) => {
      await tx
        .delete(schema.nativeCommandTurns)
        .where(
          eq(schema.nativeCommandTurns.operationId, command.input.operationId),
        );
    });
    const valid = {
      kind: "terminal",
      nativeTurnId: command.turnId,
      runtimeGeneration: command.input.session.runtimeGeneration,
    };
    for (const patch of [
      { terminalEvidence: { ...valid, kind: "declined" } },
      { terminalEvidence: { ...valid, kind: "native-rejected" } },
      { terminalEvidence: { ...valid, runtimeGeneration: randomUUID() } },
      { terminalEvidence: { ...valid, nativeTurnId: "" } },
      { terminalEvidence: null },
      { terminalEvidence: valid, executionCompletedAt: null },
    ]) {
      await transact(async (tx) => {
        await tx
          .update(schema.nativeCommands)
          .set(patch)
          .where(
            eq(schema.nativeCommands.operationId, command.input.operationId),
          );
      });
      await expect(
        f.repository.nativeHistoryItems.resolve(
          f.ownerId,
          request([command.item]),
        ),
      ).rejects.toMatchObject({ code: "input-command-turn-unobserved" });
      await transact(async (tx) => {
        expect(
          await tx
            .select()
            .from(schema.nativeCommandTurns)
            .where(
              eq(
                schema.nativeCommandTurns.operationId,
                command.input.operationId,
              ),
            ),
        ).toEqual([]);
      });
    }
  });

  it("rolls back reservations when a later item is unauthorized", async () => {
    const input = request([
      { identity: identity(), association: { kind: "native" } },
      {
        identity: { ...identity("bad"), threadId: "unrelated-thread" },
        association: { kind: "native" },
      },
    ]);
    await expect(
      f.repository.nativeHistoryItems.resolve(f.ownerId, input),
    ).rejects.toMatchObject({ code: "item-thread-mismatch" });
    await expect(
      f.repository.nativeHistoryItems.resolve("unrelated-owner", request([])),
    ).rejects.toMatchObject({ code: "chat-not-found" });
    await transact(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryItems)
          .where(eq(schema.nativeHistoryItems.chatId, f.chatId)),
      ).toEqual([]);
    });
  });

  it("rolls back acknowledgment and activation updates if durable native identity storage fails", async () => {
    const command = await guiInput();
    await transact(async (tx) => {
      await tx.execute(
        sql`CREATE FUNCTION reject_fixture_command_turn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture command-turn persistence failure'; END $$`,
      );
      await tx.execute(
        sql`CREATE TRIGGER reject_fixture_command_turn AFTER INSERT ON native_command_turns FOR EACH ROW EXECUTE FUNCTION reject_fixture_command_turn()`,
      );
    });
    try {
      await expect(command.observe()).rejects.toThrow();
      await transact(async (tx) => {
        expect(
          await tx
            .select()
            .from(schema.nativeCommandTurns)
            .where(eq(schema.nativeCommandTurns.chatId, f.chatId)),
        ).toEqual([]);
        const [saved] = await tx
          .select()
          .from(schema.nativeCommands)
          .where(
            eq(schema.nativeCommands.operationId, command.input.operationId),
          );
        expect(saved?.status).toBe("dispatched");
        expect(saved?.resultDigest).toBeNull();
        const [active] = await tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, f.chatId));
        expect(active?.nativeTurnId).toBeNull();
      });
    } finally {
      await transact(async (tx) => {
        await tx.execute(
          sql`DROP TRIGGER reject_fixture_command_turn ON native_command_turns`,
        );
        await tx.execute(sql`DROP FUNCTION reject_fixture_command_turn()`);
      });
    }
    await command.observe();
    await command.observe();
    await transact(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.nativeCommandTurns)
          .where(
            and(
              eq(schema.nativeCommandTurns.chatId, f.chatId),
              eq(
                schema.nativeCommandTurns.operationId,
                command.input.operationId,
              ),
            ),
          ),
      ).toHaveLength(1);
    });
    expect(
      await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([command.item]),
      ),
    ).toHaveLength(1);
  });
});

function preparedItem(
  mapping: NativeHistoryItemMapping,
  ordinal = 0,
): NativeHistoryPreparedBatch["items"][number] {
  return {
    identity: mapping.identity,
    revision: 1,
    state: "completed",
    order: { turn: 0, item: ordinal, component: 0 },
    message: mapping.preservedInput ?? {
      id: mapping.messageId,
      idempotencyKey: mapping.idempotencyKey,
      classification: { role: "assistant", mode: "default", attachmentIds: [] },
      protectedContent: { formatVersion: 1, keyRevision: 1, envelope },
      reasoningEffort: null,
    },
    attachments: [],
  };
}
function ingestInput(items: NativeHistoryPreparedBatch["items"]) {
  return nativeHistoryIngestSchema.parse({
    workerId: binding.workerId,
    chatId: binding.chatId,
    bindingId: binding.id,
    streamId: randomUUID(),
    sequence: 1,
    recordId: randomUUID(),
    digest: "a".repeat(64),
    previousDigest: null,
    batch: { items, turns: [] },
  });
}
async function nativeMapping(itemId = randomUUID()) {
  const [mapping] = await f.repository.nativeHistoryItems.resolve(
    f.ownerId,
    request([
      {
        identity: { ...identity(itemId), component: "assistant" },
        association: { kind: "native" },
      },
    ]),
  );
  return mapping!;
}

async function existingOutput(
  component: "assistant" | "activity",
  scoped: boolean,
) {
  const command = await guiInput();
  await command.observe();
  const service = {
    ownerId: () => f.ownerId,
    componentKey: () => ({ key: new Uint8Array(32).fill(17), keyRevision: 1 }),
  } as unknown as WorkerEncryptionService;
  const sealer = new EncryptedChatEventSealer(service, f.chatId, {
    explanation: null,
    steps: [],
    question: null,
  });
  const itemId = randomUUID();
  const correlation = {
    sourceMethod: "item/completed",
    diagnosticId: null,
    threadId: binding.threadId,
    turnId: command.turnId,
    itemId,
  };
  const agentScope = {
    agentThreadId: binding.threadId,
    rootThreadId: binding.threadId,
    parentThreadId: null,
    rootTurnId: command.turnId,
    agentPath: ["root"],
    nickname: null,
    role: null,
    depth: 0,
    isRoot: true,
  };
  const seal = (complete: boolean, includeScope = scoped) =>
    component === "assistant"
      ? sealer.message({
          id: itemId,
          text: complete ? "private final answer" : "private partial answer",
          phase: "final_answer",
          streaming: !complete,
          correlation,
          ...(includeScope ? { agentScope } : {}),
        })
      : sealer.activity({
          type: "command",
          id: itemId,
          status: complete ? "completed" : "running",
          command: "private fixture command",
          cwd: "/private/fixture",
          exitCode: complete ? 0 : null,
          output: complete ? "private command result" : null,
          correlation,
          ...(includeScope ? { agentScope } : {}),
        });
  const event = await seal(false);
  await f.repository.appendEncryptedMessage(f.ownerId, f.chatId, event.message);
  const item = {
    identity: { ...identity(itemId, command.turnId), component },
    association: {
      kind: "command-output" as const,
      operationId: command.input.operationId,
      operationGeneration: command.grant.receipt.operationGeneration,
    },
  };
  return { command, service, seal, event, item };
}

describe("existing encrypted native output aliases", () => {
  it("keeps the legacy writer active when the canonical transaction rolls back", async () => {
    const output = await existingOutput("assistant", false);
    const [mapping] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([output.item]),
    );
    const final = await output.seal(true);
    const item = preparedItem(mapping!);
    item.message = final.message;
    await transact(async (tx) => {
      await tx.execute(
        sql`CREATE FUNCTION reject_fixture_history_takeover() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture history takeover failure'; END $$`,
      );
      await tx.execute(
        sql`CREATE TRIGGER reject_fixture_history_takeover AFTER UPDATE ON native_history_items FOR EACH ROW EXECUTE FUNCTION reject_fixture_history_takeover()`,
      );
    });
    try {
      await expect(
        f.repository.nativeHistoryIngestion.ingest(
          f.ownerId,
          ingestInput([item]),
        ),
      ).rejects.toThrow();
      const [reserved] = await transact((tx) =>
        tx.select().from(schema.nativeHistoryItems),
      );
      expect(reserved?.revision).toBe(0);
      expect(
        await f.repository.getEncryptedMessageByIdempotencyKey(
          f.ownerId,
          f.chatId,
          mapping!.idempotencyKey,
        ),
      ).toMatchObject({
        protectedContent: output.event.message.protectedContent,
      });
      // Even while the failed canonical updater is unavailable, an ordinary
      // legacy write is still permitted; a failed attempt never takes ownership.
      expect(
        await f.repository.upsertEncryptedMessage(
          f.ownerId,
          f.chatId,
          final.message,
        ),
      ).toMatchObject({ protectedContent: final.message.protectedContent });
      expect(
        await transact((tx) => tx.select().from(schema.nativeHistoryReceipts)),
      ).toEqual([]);
    } finally {
      await transact(async (tx) => {
        await tx.execute(
          sql`DROP TRIGGER reject_fixture_history_takeover ON native_history_items`,
        );
        await tx.execute(sql`DROP FUNCTION reject_fixture_history_takeover()`);
      });
    }
  });

  it.each(["assistant", "activity"] as const)(
    "hands %s publication to the canonical writer only after commit and suppresses late legacy scope aliases",
    async (component) => {
      const output = await existingOutput(component, false);
      const [mapping] = await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([output.item]),
      );
      const final = await output.seal(true);
      // A reserved identity alone does not suppress legitimate old-writer output.
      const beforeCommit = await f.repository.upsertEncryptedMessage(
        f.ownerId,
        f.chatId,
        final.message,
      );
      expect(beforeCommit?.protectedContent).toEqual(
        final.message.protectedContent,
      );
      const item = preparedItem(mapping!);
      item.message = final.message;
      await f.repository.nativeHistoryIngestion.ingest(
        f.ownerId,
        ingestInput([item]),
      );
      const before = await transact(async (tx) => ({
        messages: await tx.select().from(schema.chatMessages),
        items: await tx.select().from(schema.nativeHistoryItems),
        receipts: await tx.select().from(schema.nativeHistoryReceipts),
      }));
      const stale = await output.seal(false);
      const alternateScope = await output.seal(false, true);
      for (const late of [stale, alternateScope]) {
        for (const method of [
          "upsertEncryptedMessage",
          "appendEncryptedMessage",
        ] as const) {
          const saved = await f.repository[method](
            f.ownerId,
            f.chatId,
            late.message,
          );
          expect(saved?.id).toBe(final.message.id);
          expect(saved?.protectedContent).toEqual(
            final.message.protectedContent,
          );
        }
      }
      await expect(
        f.repository.upsertEncryptedMessage(f.ownerId, f.chatId, {
          ...alternateScope.message,
          id: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "item-canonical-message-conflict" });
      expect(
        await f.repository.upsertEncryptedMessage(
          randomUUID(),
          f.chatId,
          stale.message,
        ),
      ).toBeNull();
      const after = await transact(async (tx) => ({
        messages: await tx.select().from(schema.chatMessages),
        items: await tx.select().from(schema.nativeHistoryItems),
        receipts: await tx.select().from(schema.nativeHistoryReceipts),
      }));
      expect(after).toEqual(before);
    },
  );

  it.each([false, true])(
    "serializes legacy writes with canonical commit (canonical first=%s)",
    async (canonicalFirst) => {
      const output = await existingOutput("assistant", true);
      const [mapping] = await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([output.item]),
      );
      const completed = await output.seal(true);
      const item = preparedItem(mapping!);
      item.message = completed.message;
      const stale = await output.seal(false);
      const commit = () =>
        f.repository.nativeHistoryIngestion.ingest(
          f.ownerId,
          ingestInput([item]),
        );
      const legacy = () =>
        f.repository.upsertEncryptedMessage(f.ownerId, f.chatId, stale.message);
      await Promise.all(
        (canonicalFirst ? [commit, legacy] : [legacy, commit]).map((write) =>
          write(),
        ),
      );
      const saved = await f.repository.getEncryptedMessageByIdempotencyKey(
        f.ownerId,
        f.chatId,
        mapping!.idempotencyKey,
      );
      expect(saved?.protectedContent).toEqual(
        completed.message.protectedContent,
      );
      expect(
        await transact((tx) => tx.select().from(schema.chatMessages)),
      ).toHaveLength(2);
    },
  );

  it.each([
    ["assistant", false, false],
    ["assistant", true, false],
    ["activity", false, false],
    ["activity", true, false],
    ["assistant", false, true],
    ["assistant", true, true],
    ["activity", false, true],
    ["activity", true, true],
    ["assistant", false, "output"],
    ["assistant", true, "output"],
    ["activity", false, "output"],
    ["activity", true, "output"],
  ] as const)(
    "reuses %s output from the actual worker sealer (scoped=%s, observed=%s)",
    async (component, scoped, observed) => {
      const output = await existingOutput(component, scoped);
      const selected = observed
        ? {
            identity: output.item.identity,
            association: {
              kind:
                observed === "output"
                  ? ("output" as const)
                  : ("observed-output" as const),
            },
          }
        : output.item;
      const [mapping] = await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([selected]),
      );
      expect(mapping).toMatchObject({
        messageId: output.event.message.id,
        idempotencyKey: output.event.message.idempotencyKey,
        preservedInput: null,
      });
      const completed = await output.seal(true);
      const item = preparedItem(mapping!);
      item.message = completed.message;
      const input = ingestInput([item]);
      const receipt = await f.repository.nativeHistoryIngestion.ingest(
        f.ownerId,
        input,
      );
      expect(
        await f.repository.nativeHistoryIngestion.ingest(f.ownerId, input),
      ).toEqual(receipt);
      await transact(async (tx) => {
        const rows = await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, f.chatId));
        expect(rows).toHaveLength(2); // Original GUI input plus exactly one output.
        const saved = rows.find((row) => row.id === mapping!.messageId)!;
        expect(saved.content).toBeNull();
        expect(saved.protectedContent).toEqual(
          completed.message.protectedContent,
        );
        expect(JSON.stringify(saved)).not.toContain("private final answer");
        if (component === "assistant") {
          expect(
            await openEncryptedChatTurn({
              service: output.service,
              threadId: binding.threadId,
              history: [],
              prompt: {
                ...completed.message,
                protectedContent: saved.protectedContent!,
              },
            }),
          ).toBe("private final answer");
        }
      });
      await expect(
        f.repository.nativeHistoryItems.resolve(
          f.ownerId,
          request([
            {
              ...output.item,
              identity: { ...output.item.identity, identityKind: "legacy" },
            },
          ]),
        ),
      ).rejects.toMatchObject({ code: "output-alias-already-claimed" });
    },
  );

  it("recovers first-time output provenance from terminal receipts on another historical worker binding", async () => {
    const output = await existingOutput("assistant", true);
    await output.command.observe(true);
    const otherWorkerId = randomUUID();
    const otherBindingId = randomUUID();
    await transact(async (tx) => {
      await tx
        .delete(schema.nativeCommandTurns)
        .where(
          eq(
            schema.nativeCommandTurns.operationId,
            output.command.input.operationId,
          ),
        );
      const [worker] = await tx
        .select()
        .from(schema.workers)
        .where(eq(schema.workers.id, f.workerId));
      await tx.insert(schema.workers).values({ ...worker!, id: otherWorkerId });
      await tx.insert(schema.nativeHistoryBindings).values({
        ...binding,
        id: otherBindingId,
        workerId: otherWorkerId,
        ownerId: f.ownerId,
        createdAt: new Date(binding.createdAt),
      });
    });
    const replacement = await guiInput();
    await replacement.observe();
    const before = await f.repository.getChatExecutionContext(
      f.ownerId,
      f.chatId,
    );
    const migrated = {
      ...request([
        {
          identity: output.item.identity,
          association: { kind: "observed-output" },
        },
      ]),
      workerId: otherWorkerId,
      bindingId: otherBindingId,
    };
    const [mapping] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      migrated,
    );
    expect(mapping?.messageId).toBe(output.event.message.id);
    expect(
      await f.repository.nativeHistoryItems.resolve(f.ownerId, {
        ...migrated,
        items: [output.item],
      }),
    ).toEqual([mapping]);
    await expect(
      f.repository.nativeHistoryItems.resolve(randomUUID(), migrated),
    ).rejects.toMatchObject({ code: "chat-not-found" });
    expect(
      await f.repository.getChatExecutionContext(f.ownerId, f.chatId),
    ).toEqual(before);
    await transact(async (tx) => {
      const [saved] = await tx
        .select()
        .from(schema.nativeCommandTurns)
        .where(
          eq(
            schema.nativeCommandTurns.operationId,
            output.command.input.operationId,
          ),
        );
      expect(saved?.turnId).toBe(output.command.turnId);
      const [command] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(
          eq(
            schema.nativeCommands.operationId,
            output.command.input.operationId,
          ),
        );
      expect(command?.workerId).toBe(f.workerId);
      // A lost reservation reply can still be recovered without rebuilding old
      // provenance, even if its historical index is subsequently unavailable.
      await tx
        .delete(schema.nativeCommandTurns)
        .where(
          eq(
            schema.nativeCommandTurns.operationId,
            output.command.input.operationId,
          ),
        );
      await tx
        .update(schema.nativeCommands)
        .set({ terminalEvidence: null })
        .where(
          eq(
            schema.nativeCommands.operationId,
            output.command.input.operationId,
          ),
        );
    });
    expect(
      await f.repository.nativeHistoryItems.resolve(f.ownerId, migrated),
    ).toEqual([mapping]);
  });

  it("does not reserve an observed output without exact canonical turn ownership and an existing message", async () => {
    const output = await existingOutput("assistant", false);
    const observed = {
      identity: output.item.identity,
      association: { kind: "observed-output" as const },
    };
    for (const [identity, code] of [
      [
        { ...observed.identity, turnId: randomUUID() },
        "output-provenance-unavailable",
      ],
      [
        { ...observed.identity, itemId: randomUUID() },
        "output-message-unavailable",
      ],
      [
        { ...observed.identity, component: "user" },
        "output-alias-component-mismatch",
      ],
      [
        { ...observed.identity, identityKind: "legacy" as const },
        "observed-output-identity-mismatch",
      ],
    ] as const) {
      await expect(
        f.repository.nativeHistoryItems.resolve(
          f.ownerId,
          request([{ ...observed, identity }]),
        ),
      ).rejects.toMatchObject({ code });
    }
    await transact((tx) =>
      tx
        .delete(schema.nativeCommandTurns)
        .where(
          eq(
            schema.nativeCommandTurns.operationId,
            output.command.input.operationId,
          ),
        ),
    );
    // A dispatched/applied but unfinished command without an observed turn
    // cannot be recovered from a guessed output key.
    await expect(
      f.repository.nativeHistoryItems.resolve(f.ownerId, request([observed])),
    ).rejects.toMatchObject({ code: "output-provenance-unavailable" });
    expect(
      await transact((tx) => tx.select().from(schema.nativeHistoryItems)),
    ).toEqual([]);
  });

  it("rejects multiple command owners for an observed output without choosing the active one", async () => {
    const output = await existingOutput("activity", true);
    await output.command.observe(true);
    const replacement = await guiInput();
    await replacement.observe(true);
    // The indexed table has unique turn ownership. Conflicting pre-index
    // terminal receipts must be detected before attempting to backfill it.
    await transact(async (tx) => {
      await tx
        .delete(schema.nativeCommandTurns)
        .where(eq(schema.nativeCommandTurns.chatId, f.chatId));
      await tx
        .update(schema.nativeCommands)
        .set({
          terminalEvidence: {
            kind: "terminal",
            nativeTurnId: output.command.turnId,
            runtimeGeneration: replacement.input.session.runtimeGeneration,
          },
        })
        .where(
          eq(schema.nativeCommands.operationId, replacement.input.operationId),
        );
    });
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          {
            identity: output.item.identity,
            association: { kind: "observed-output" },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "output-provenance-ambiguous" });
    expect(
      await transact((tx) => tx.select().from(schema.nativeHistoryItems)),
    ).toEqual([]);
    expect(
      await transact((tx) => tx.select().from(schema.nativeCommandTurns)),
    ).toEqual([]);
  });

  it("rejects a wrong operation generation, native turn, missing output and association changes", async () => {
    const output = await existingOutput("assistant", true);
    for (const [item, code] of [
      [
        {
          ...output.item,
          association: {
            ...output.item.association,
            operationGeneration: randomUUID(),
          },
        },
        "output-command-not-bound",
      ],
      [
        {
          ...output.item,
          identity: { ...output.item.identity, turnId: randomUUID() },
        },
        "output-command-turn-mismatch",
      ],
      [
        {
          ...output.item,
          identity: { ...output.item.identity, itemId: randomUUID() },
        },
        "output-message-unavailable",
      ],
    ] as const) {
      await expect(
        f.repository.nativeHistoryItems.resolve(f.ownerId, request([item])),
      ).rejects.toMatchObject({ code });
    }
    await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([output.item]),
    );
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          { identity: output.item.identity, association: { kind: "native" } },
        ]),
      ),
    ).rejects.toMatchObject({ code: "item-association-conflict" });
  });

  it("does not adopt an arbitrary message just because its key has the right prefix", async () => {
    const output = await existingOutput("assistant", false);
    await transact(async (tx) => {
      await tx
        .update(schema.chatMessages)
        .set({ id: randomUUID() })
        .where(eq(schema.chatMessages.id, output.event.message.id));
    });
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([output.item]),
      ),
    ).rejects.toMatchObject({ code: "output-message-identity-mismatch" });
  });

  it("reports conflicting historical scope aliases instead of choosing an arbitrary row", async () => {
    const output = await existingOutput("assistant", false);
    const scoped = await output.seal(true, true);
    await f.repository.appendEncryptedMessage(
      f.ownerId,
      f.chatId,
      scoped.message,
    );
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([output.item]),
      ),
    ).rejects.toMatchObject({ code: "output-alias-ambiguous" });
    await transact(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryItems)
          .where(eq(schema.nativeHistoryItems.chatId, f.chatId)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, f.chatId)),
      ).toHaveLength(3);
    });
  });
});

async function prepareQueuedInput(steer = false, goal = false) {
  const root = steer ? await guiInput() : null;
  if (root) await root.observe();
  const context = (await f.repository.getChatExecutionContext(
    f.ownerId,
    f.chatId,
  ))!;
  const session = root?.input.session ?? {
    chatId: f.chatId,
    threadId: binding.threadId,
    contextKind: "project" as const,
    projectId: f.projectId,
    placementId: binding.worktreeId,
    modelRouteId: binding.modelRouteId,
    providerAccountId: binding.providerAccountId,
    runtimeGeneration: randomUUID(),
    connectionId: "queue-history-fixture",
  };
  const messageId = randomUUID();
  const prompt = queuedPromptOpaqueContentSchema.parse({
    id: randomUUID(),
    classification: { mode: goal ? "goal" : "default", attachmentIds: [] },
    protectedContent: { formatVersion: 1, keyRevision: 1, envelope },
    modelId: context.modelId!,
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
    worktreeId: null,
    frozen: false,
    idempotencyKey: `queued:${messageId}`,
    pendingMessage: {
      id: messageId,
      idempotencyKey: `queued-input:${messageId}`,
      classification: {
        role: "user",
        mode: goal ? "goal" : "default",
        attachmentIds: [],
      },
      protectedContent: { formatVersion: 1, keyRevision: 1, envelope },
      reasoningEffort: null,
    },
    nativeClientUserMessageId: `custom-native-client:${randomUUID()}`,
    nativeAction: "literal",
    executionMethod: goal ? "thread/goal/set" : "turn/start",
  });
  const mutation = async (kind: "add" | "start") => {
    const snapshot = await f.repository.managedQueue.snapshot(
      f.ownerId,
      f.chatId,
    );
    const result = await f.repository.managedQueue.mutate(f.ownerId, {
      admission: nativeCommandAdmissionSchema.parse({
        workerId: f.workerId,
        operationId: randomUUID(),
        origin: "gui",
        method: `thread/queue/${kind}`,
        session,
        payloadDigest: "a".repeat(64),
        protectedPayload: envelope,
        expectedActivationGeneration: null,
        intent: { scope: "thread", resumeAutonomy: true },
      }),
      expectedRevision: snapshot.revision,
      mutation:
        kind === "add"
          ? { kind, prompt, attachments: [] }
          : { kind, id: prompt.id },
    });
    expect(result.receipt.status).toBe("applied");
    return result;
  };
  await mutation("add");
  const claim = async (method: "next" | "item" | "start" = "next") =>
    method === "next"
      ? (await f.repository.managedQueue.claimNext(f.ownerId, f.chatId))!
      : method === "item"
        ? await f.repository.managedQueue.claimItem(
            f.ownerId,
            f.chatId,
            prompt.id,
            0,
            randomUUID(),
          )
        : (await mutation("start")).claim!;
  const accept = async (claimed: ManagedQueueClaim) => {
    let goalQueueHandoff: NativeCommandAdmission["goalQueueHandoff"];
    if (goal) {
      const parent = nativeCommandAdmissionSchema.parse({
        workerId: f.workerId,
        operationId: randomUUID(),
        origin: "gui",
        method: "thread/goal/set",
        session,
        payloadDigest: "c".repeat(64),
        protectedPayload: envelope,
        queueClaim: { id: claimed.id, promptRevision: claimed.promptRevision },
        expectedActivationGeneration: null,
        intent: { scope: "thread", resumeAutonomy: true, goalStatus: "active" },
      });
      const grant = await f.repository.nativeCommands.admit(f.ownerId, parent);
      expect(grant.receipt.status).toBe("accepted");
      await f.repository.nativeCommands.dispatch(f.ownerId, {
        workerId: f.workerId,
        operationId: parent.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        payloadDigest: parent.payloadDigest,
        session,
      });
      const goalEpoch = randomUUID();
      await f.repository.nativeCommands.settle(f.ownerId, {
        workerId: f.workerId,
        operationId: parent.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        status: "applied",
        resultDigest: "d".repeat(64),
        protectedResult: envelope,
        rejectionCode: null,
        executionComplete: false,
        goalEpoch,
      });
      goalQueueHandoff = {
        claimId: claimed.id,
        operationId: parent.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        goalEpoch,
      };
    }
    const input = nativeCommandAdmissionSchema.parse({
      workerId: f.workerId,
      operationId: randomUUID(),
      origin: goal ? "autonomous" : "gui",
      method: steer ? "turn/steer" : "turn/start",
      session,
      payloadDigest: "c".repeat(64),
      protectedPayload: envelope,
      ...(goalQueueHandoff
        ? { goalQueueHandoff }
        : {
            queueClaim: {
              id: claimed.id,
              promptRevision: claimed.promptRevision,
            },
          }),
      expectedActivationGeneration:
        root?.grant.receipt.activationGeneration ?? null,
      intent: { scope: "thread", expectedTurnId: root?.turnId ?? null },
    });
    const grant = await f.repository.nativeCommands.admit(f.ownerId, input);
    expect(grant.receipt.status).toBe("accepted");
    await f.repository.nativeCommands.dispatch(f.ownerId, {
      workerId: f.workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      payloadDigest: input.payloadDigest,
      session: input.session,
    });
    const turnId = root?.turnId ?? randomUUID();
    await f.repository.nativeCommands.settle(f.ownerId, {
      workerId: f.workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      resultDigest: "d".repeat(64),
      protectedResult: envelope,
      rejectionCode: null,
      executionComplete: false,
      ...(!steer
        ? {
            reconciliation: {
              nativeTurnId: turnId,
              runtimeGeneration: session.runtimeGeneration!,
            },
          }
        : {}),
    });
    const association = {
      claimId: claimed.id,
      promptRevision: claimed.promptRevision,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
    };
    if (goal)
      return {
        identity: {
          ...identity(claimed.id, turnId),
          component: "goal-request",
        },
        association: { ...association, kind: "queue-goal" as const },
      };
    return {
      identity: identity(randomUUID(), turnId),
      association: {
        kind: "queue-input" as const,
        ...association,
        clientUserMessageId: prompt.nativeClientUserMessageId!,
      },
    };
  };
  return { root, prompt, claim, accept };
}

describe("durable queued input history", () => {
  it.each([false, true])(
    "selects retained queued input by its custom native client ID (steer=%s)",
    async (steer) => {
      const queued = await prepareQueuedInput(steer);
      const claim = await queued.claim();
      const item = await queued.accept(claim);
      await transact((tx) =>
        tx
          .update(schema.queuedPrompts)
          .set({ revision: 1 })
          .where(eq(schema.queuedPrompts.id, queued.prompt.id)),
      );
      const [mapping] = await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([observedInput(item)]),
      );
      expect(mapping?.preservedInput).toEqual(queued.prompt.pendingMessage);
      expect(
        await f.repository.nativeHistoryItems.resolve(
          f.ownerId,
          request([item]),
        ),
      ).toEqual([mapping]);
      // A lost first response can recover the reserved identity even if the legacy
      // input sources later disappear. The reservation already preserves its body.
      await transact((tx) =>
        tx
          .delete(schema.managedQueueInputSnapshots)
          .where(eq(schema.managedQueueInputSnapshots.claimId, claim.id)),
      );
      expect(
        await f.repository.nativeHistoryItems.resolve(
          f.ownerId,
          request([observedInput(item)]),
        ),
      ).toEqual([mapping]);
    },
  );

  it("does not classify a queued input as native when its exact retained revision is missing", async () => {
    const queued = await prepareQueuedInput();
    const claim = await queued.claim();
    const item = await queued.accept(claim);
    await transact(async (tx) => {
      await tx
        .delete(schema.managedQueueInputSnapshots)
        .where(eq(schema.managedQueueInputSnapshots.claimId, claim.id));
      await tx
        .update(schema.queuedPrompts)
        .set({ revision: 1 })
        .where(eq(schema.queuedPrompts.id, queued.prompt.id));
    });
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([observedInput(item)]),
      ),
    ).rejects.toMatchObject({ code: "queue-input-revision-unavailable" });
    expect(
      await transact((tx) => tx.select().from(schema.nativeHistoryItems)),
    ).toEqual([]);
  });

  it("uses the acknowledged goal attempt rather than its configuration command as input provenance", async () => {
    const queued = await prepareQueuedInput(false, true);
    const claim = await queued.claim();
    const item = await queued.accept(claim);
    const [mapping] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([item]),
    );
    expect(mapping?.preservedInput).toEqual(queued.prompt.pendingMessage);
    const consumed = (await f.repository.managedQueue.claim(
      f.ownerId,
      f.chatId,
      claim.id,
    ))!;
    expect(consumed).toMatchObject({
      status: "consumed",
      awaitingGoal: true,
      goalOperationId: item.association.operationId,
    });
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          {
            ...item,
            identity: {
              ...item.identity,
              component: "user",
              itemId: "invented-native-input",
            },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "queue-input-component-mismatch" });
    await expect(
      f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([
          {
            ...item,
            association: {
              ...item.association,
              operationId: consumed.operationId!,
              operationGeneration: consumed.operationGeneration!,
            },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "queue-input-claim-mismatch" });
  });

  it.each([false, true])(
    "recovers an old claim only from its original revision (edited=%s)",
    async (edited) => {
      const queued = await prepareQueuedInput();
      const claim = await queued.claim();
      const item = await queued.accept(claim);
      await transact(async (tx) => {
        await tx
          .delete(schema.managedQueueInputSnapshots)
          .where(eq(schema.managedQueueInputSnapshots.claimId, claim.id));
        if (edited)
          await tx
            .update(schema.queuedPrompts)
            .set({ revision: 1 })
            .where(eq(schema.queuedPrompts.id, queued.prompt.id));
      });
      if (edited) {
        await expect(
          f.repository.nativeHistoryItems.resolve(f.ownerId, request([item])),
        ).rejects.toMatchObject({ code: "queue-input-revision-unavailable" });
      } else {
        const [mapping] = await f.repository.nativeHistoryItems.resolve(
          f.ownerId,
          request([item]),
        );
        expect(mapping?.preservedInput).toEqual(queued.prompt.pendingMessage);
      }
      await transact(async (tx) => {
        expect(
          await tx
            .select()
            .from(schema.managedQueueInputSnapshots)
            .where(eq(schema.managedQueueInputSnapshots.claimId, claim.id)),
        ).toHaveLength(edited ? 0 : 1);
      });
    },
  );
  it.each(["next", "item", "start"] as const)(
    "retains the claimed revision via %s and ignores later draft changes",
    async (method) => {
      const queued = await prepareQueuedInput();
      const claim = await queued.claim(method);
      const item = await queued.accept(claim);
      await transact(async (tx) => {
        const [retained] = await tx
          .select()
          .from(schema.managedQueueInputSnapshots)
          .where(eq(schema.managedQueueInputSnapshots.claimId, claim.id));
        expect(retained?.protectedInput).toEqual(queued.prompt);
        const changed = structuredClone(queued.prompt);
        changed.pendingMessage.protectedContent.envelope.nonce =
          "BBBBBBBBBBBBBBBB";
        changed.nativeClientUserMessageId = "a-later-edit";
        await tx
          .update(schema.queuedPrompts)
          .set({ revision: 1, opaqueContent: changed })
          .where(eq(schema.queuedPrompts.id, queued.prompt.id));
      });
      const [mapping] = await f.repository.nativeHistoryItems.resolve(
        f.ownerId,
        request([item]),
      );
      expect(mapping?.preservedInput).toEqual(queued.prompt.pendingMessage);
      await f.repository.nativeHistoryIngestion.ingest(
        f.ownerId,
        ingestInput([preparedItem(mapping!)]),
      );
      expect(
        await f.repository.nativeHistoryItems.resolve(
          f.ownerId,
          request([item]),
        ),
      ).toEqual([mapping]);
      await transact(async (tx) => {
        const [saved] = await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.id, queued.prompt.pendingMessage.id));
        expect(saved?.protectedContent).toEqual(
          queued.prompt.pendingMessage.protectedContent,
        );
      });
    },
  );

  it("maps a queued steer through its historical root activation after another turn replaces it", async () => {
    const queued = await prepareQueuedInput(true);
    const item = await queued.accept(await queued.claim());
    await queued.root!.observe(true);
    const next = await guiInput();
    await next.observe();
    const before = await transact((tx) =>
      tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, f.chatId)),
    );
    const [mapping] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([item]),
    );
    expect(mapping?.messageId).toBe(queued.prompt.pendingMessage.id);
    await f.repository.nativeHistoryIngestion.ingest(
      f.ownerId,
      ingestInput([preparedItem(mapping!)]),
    );
    expect(
      await transact((tx) =>
        tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, f.chatId)),
      ),
    ).toEqual(before);
  });

  it("rejects a wrong claim revision, client ID or turn without reserving a message", async () => {
    const queued = await prepareQueuedInput();
    const item = await queued.accept(await queued.claim());
    for (const [changed, code] of [
      [
        { ...item, association: { ...item.association, promptRevision: 1 } },
        "queue-input-claim-mismatch",
      ],
      [
        {
          ...item,
          association: {
            ...item.association,
            clientUserMessageId: `cantrip:${queued.prompt.pendingMessage.id}`,
          },
        },
        "queue-input-client-id-mismatch",
      ],
      [
        { ...item, identity: { ...item.identity, turnId: randomUUID() } },
        "queue-input-turn-mismatch",
      ],
    ] as const) {
      await expect(
        f.repository.nativeHistoryItems.resolve(f.ownerId, request([changed])),
      ).rejects.toMatchObject({ code });
    }
    expect(
      await transact((tx) =>
        tx
          .select()
          .from(schema.nativeHistoryItems)
          .where(eq(schema.nativeHistoryItems.chatId, f.chatId)),
      ),
    ).toEqual([]);
  });

  it("rolls back claim creation if retaining the exact encrypted input fails", async () => {
    const queued = await prepareQueuedInput();
    await transact(async (tx) => {
      await tx.execute(
        sql`CREATE FUNCTION reject_fixture_queue_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture queue snapshot failure'; END $$`,
      );
      await tx.execute(
        sql`CREATE TRIGGER reject_fixture_queue_snapshot AFTER INSERT ON managed_queue_input_snapshots FOR EACH ROW EXECUTE FUNCTION reject_fixture_queue_snapshot()`,
      );
    });
    try {
      await expect(queued.claim()).rejects.toThrow();
      await transact(async (tx) => {
        expect(
          await tx
            .select()
            .from(schema.managedQueueClaims)
            .where(eq(schema.managedQueueClaims.chatId, f.chatId)),
        ).toEqual([]);
        const [prompt] = await tx
          .select()
          .from(schema.queuedPrompts)
          .where(eq(schema.queuedPrompts.id, queued.prompt.id));
        expect(prompt?.state).toBe("pending");
      });
    } finally {
      await transact(async (tx) => {
        await tx.execute(
          sql`DROP TRIGGER reject_fixture_queue_snapshot ON managed_queue_input_snapshots`,
        );
        await tx.execute(sql`DROP FUNCTION reject_fixture_queue_snapshot()`);
      });
    }
    const claimed = await queued.claim();
    expect(claimed.promptId).toBe(queued.prompt.id);
  });
});

describe("canonical native message ingestion", () => {
  it("commits messages, attachment metadata, item revisions and receipts atomically after a real mid-batch DB failure", async () => {
    const first = preparedItem(await nativeMapping());
    const second = preparedItem(await nativeMapping(), 1);
    const service = {
      ownerId: () => f.ownerId,
      serverIdentity: () => f.serverId,
      componentKey: () => ({
        key: new Uint8Array(32).fill(64),
        keyRevision: 1,
      }),
    };
    const source: NativeHistoryStateItem = {
      id: first.identity.itemId,
      identityKind: "canonical",
      revision: 1,
      ordinal: 0,
      body: {
        id: first.identity.itemId,
        type: "agentMessage",
        text: "preview",
        fullNativeExtension: "private archival fixture\n".repeat(15_000),
      },
      lifecycle: "completed",
      completeBody: true,
      startedAtMs: null,
      completedAtMs: null,
      origin: { kind: "notification", generation: "runtime", sequence: 1 },
      conflicts: [],
    };
    first.evidence = await protectNativeHistoryItemEvidence({
      service,
      binding,
      identity: first.identity,
      revision: first.revision,
      source,
    });
    const attachment = {
      id: randomUUID(),
      chatId: binding.chatId,
      sizeBytes: 12,
      status: "ready" as const,
      protectedMetadata: {
        formatVersion: 1 as const,
        keyRevision: 1,
        envelope,
      },
      createdAt: new Date().toISOString(),
    };
    first.attachments = [attachment];
    first.message.classification.attachmentIds = [attachment.id];
    second.message.classification.attachmentIds = [attachment.id];
    const input = ingestInput([first, second]);
    await transact(async (tx) => {
      // The generated UUID is fixture-owned SQL data; no private/user content is interpolated.
      await tx.execute(
        sql.raw(
          `CREATE FUNCTION reject_fixture_second_history_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${second.message.id}' THEN RAISE EXCEPTION 'fixture second canonical write failure'; END IF; RETURN NEW; END $$`,
        ),
      );
      await tx.execute(
        sql`CREATE TRIGGER reject_fixture_second_history_message AFTER INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION reject_fixture_second_history_message()`,
      );
    });
    try {
      await expect(
        f.repository.nativeHistoryIngestion.ingest(f.ownerId, input),
      ).rejects.toThrow();
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
            .from(schema.chatAttachments)
            .where(eq(schema.chatAttachments.id, attachment.id)),
        ).toEqual([]);
        expect(
          await tx
            .select()
            .from(schema.nativeHistoryStreams)
            .where(eq(schema.nativeHistoryStreams.bindingId, binding.id)),
        ).toEqual([]);
        expect(
          await tx
            .select()
            .from(schema.nativeHistoryPublications)
            .where(eq(schema.nativeHistoryPublications.bindingId, binding.id)),
        ).toEqual([]);
        const mappings = await tx
          .select()
          .from(schema.nativeHistoryItems)
          .where(eq(schema.nativeHistoryItems.chatId, f.chatId));
        expect(mappings).toHaveLength(2);
        expect(
          mappings.every(
            (mapping) =>
              mapping.revision === 0 &&
              mapping.payloadDigest === null &&
              mapping.protectedEvidence === null,
          ),
        ).toBe(true);
      });
    } finally {
      await transact(async (tx) => {
        await tx.execute(
          sql`DROP TRIGGER reject_fixture_second_history_message ON chat_messages`,
        );
        await tx.execute(
          sql`DROP FUNCTION reject_fixture_second_history_message()`,
        );
      });
    }
    const receipt = await f.repository.nativeHistoryIngestion.ingest(
      f.ownerId,
      input,
    );
    expect(
      await f.repository.nativeHistoryIngestion.ingest(f.ownerId, input),
    ).toEqual(receipt);
    const archived = await transact(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.nativeHistoryItems)
        .where(eq(schema.nativeHistoryItems.messageId, first.message.id));
      return row!.protectedEvidence!;
    });
    expect(archived).toEqual(first.evidence);
    expect(JSON.stringify(archived)).not.toContain("private archival fixture");
    expect(
      await openNativeHistoryItemEvidence({
        service,
        binding,
        identity: first.identity,
        evidence: archived,
      }),
    ).toEqual(source);
    await transact(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, f.chatId)),
      ).toHaveLength(2);
      expect(
        await tx
          .select()
          .from(schema.chatAttachments)
          .where(eq(schema.chatAttachments.id, attachment.id)),
      ).toHaveLength(1);
      expect(
        await tx
          .select()
          .from(schema.chatAttachmentReplicas)
          .where(eq(schema.chatAttachmentReplicas.attachmentId, attachment.id)),
      ).toMatchObject([{ workerId: f.workerId, status: "ready" }]);
      const mappings = await tx
        .select()
        .from(schema.nativeHistoryItems)
        .where(eq(schema.nativeHistoryItems.chatId, f.chatId));
      expect(
        mappings.every(
          (mapping) => mapping.revision === 1 && mapping.state === "completed",
        ),
      ).toBe(true);
      expect(mappings.map((mapping) => mapping.itemOrdinal).sort()).toEqual([
        0, 1,
      ]);
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryReceipts)
          .where(eq(schema.nativeHistoryReceipts.streamId, input.streamId)),
      ).toHaveLength(1);
    });
  });

  it("keeps archival evidence at its original revision when a later producer omits it", async () => {
    const prepared = preparedItem(await nativeMapping());
    prepared.evidence = {
      version: 1,
      bindingId: binding.id,
      workerId: binding.workerId,
      revision: 1,
      content: envelope,
    };
    const initial = ingestInput([prepared]);
    await f.repository.nativeHistoryIngestion.ingest(f.ownerId, initial);
    const { evidence: _evidence, ...withoutEvidence } = prepared;
    await f.repository.nativeHistoryIngestion.ingest(f.ownerId, {
      ...initial,
      sequence: 2,
      recordId: randomUUID(),
      previousDigest: initial.digest,
      digest: "b".repeat(64),
      batch: { items: [{ ...withoutEvidence, revision: 2 }], turns: [] },
    });
    await transact(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.nativeHistoryItems)
        .where(eq(schema.nativeHistoryItems.messageId, prepared.message.id));
      expect(row!.revision).toBe(2);
      expect(row!.protectedEvidence).toEqual(prepared.evidence);
    });
  });

  it("updates one native row, preserves terminal content against late starts, and rejects conflicting revisions", async () => {
    const item = preparedItem(await nativeMapping());
    item.state = "started";
    const input = ingestInput([item]);
    await f.repository.nativeHistoryIngestion.ingest(f.ownerId, input);
    const complete = structuredClone(input);
    complete.sequence = 2;
    complete.recordId = randomUUID();
    complete.previousDigest = input.digest;
    complete.digest = "b".repeat(64);
    complete.batch.items[0]!.revision = 2;
    complete.batch.items[0]!.state = "completed";
    complete.batch.items[0]!.message.protectedContent.envelope.nonce =
      "BBBBBBBBBBBBBBBB";
    await f.repository.nativeHistoryIngestion.ingest(f.ownerId, complete);
    const late = structuredClone(input);
    late.sequence = 3;
    late.recordId = randomUUID();
    late.previousDigest = complete.digest;
    late.digest = "c".repeat(64);
    late.batch.items[0]!.revision = 3;
    await f.repository.nativeHistoryIngestion.ingest(f.ownerId, late);
    await transact(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.chatId, f.chatId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.protectedContent).toEqual(
        complete.batch.items[0]!.message.protectedContent,
      );
      const [mapping] = await tx
        .select()
        .from(schema.nativeHistoryItems)
        .where(eq(schema.nativeHistoryItems.chatId, f.chatId));
      expect(mapping).toMatchObject({ revision: 2, state: "completed" });
    });
    const conflicting = structuredClone(complete);
    conflicting.sequence = 4;
    conflicting.recordId = randomUUID();
    conflicting.previousDigest = late.digest;
    conflicting.digest = "d".repeat(64);
    conflicting.batch.items[0]!.message.protectedContent.envelope.nonce =
      "CCCCCCCCCCCCCCCC";
    await expect(
      f.repository.nativeHistoryIngestion.ingest(f.ownerId, conflicting),
    ).rejects.toMatchObject({ code: "item-revision-conflict" });
    await transact(async (tx) => {
      const [stream] = await tx
        .select()
        .from(schema.nativeHistoryStreams)
        .where(eq(schema.nativeHistoryStreams.id, input.streamId));
      expect(stream?.acknowledgedSequence).toBe(3);
    });
  });

  it("maps an admitted GUI input without replacing its content, attachments or attribution", async () => {
    const command = await guiInput();
    await command.observe();
    const before = await transact((tx) =>
      tx
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, command.message.id)),
    );
    const [mapping] = await f.repository.nativeHistoryItems.resolve(
      f.ownerId,
      request([command.item]),
    );
    const input = ingestInput([preparedItem(mapping!)]);
    await f.repository.nativeHistoryIngestion.ingest(f.ownerId, input);
    const after = await transact((tx) =>
      tx
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, command.message.id)),
    );
    expect(after).toEqual(before);
    const altered = structuredClone(input);
    altered.sequence = 2;
    altered.recordId = randomUUID();
    altered.previousDigest = input.digest;
    altered.digest = "b".repeat(64);
    altered.batch.items[0]!.revision = 2;
    altered.batch.items[0]!.message.protectedContent.envelope.nonce =
      "BBBBBBBBBBBBBBBB";
    await expect(
      f.repository.nativeHistoryIngestion.ingest(f.ownerId, altered),
    ).rejects.toMatchObject({ code: "input-alias-content-conflict" });
    expect(
      await transact((tx) =>
        tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.id, command.message.id)),
      ),
    ).toEqual(before);
  });
});
