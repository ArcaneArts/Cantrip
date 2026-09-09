import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { NativeHistoryBinding } from "@cantrip/protocol";
import { EncryptedChatEventSealer } from "../src/chat-message-encryption.js";
import {
  createNativeHistoryOutputIdentityResolver,
  createManagedNativeOutputIdentityResolver,
} from "../src/native-history-output-identity.js";
import type { NativeHistoryClient } from "../src/native-history-client.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

function fixture() {
  const binding: NativeHistoryBinding = {
    id: randomUUID(),
    chatId: randomUUID(),
    workerId: randomUUID(),
    threadId: randomUUID(),
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    modelRouteId: null,
    providerAccountId: null,
    createdFromOperationId: null,
    createdAt: new Date().toISOString(),
  };
  const identity = {
    threadId: binding.threadId,
    turnId: "turn",
    itemId: "answer",
    component: "assistant",
    identityKind: "canonical" as const,
  };
  const mapping = {
    identity,
    key: "a".repeat(64),
    messageId: randomUUID(),
    idempotencyKey: "native-history:fixture",
    preservedInput: null,
  };
  const resolve = vi
    .fn<NativeHistoryClient["resolve"]>()
    .mockResolvedValue([mapping]);
  const service = {
    ownerId: () => "owner",
    componentKey: () => ({ key: new Uint8Array(32).fill(7), keyRevision: 1 }),
  } as unknown as WorkerEncryptionService;
  const resolver = createNativeHistoryOutputIdentityResolver({
    binding,
    client: { resolve },
    identity: () => identity,
  });
  const sealer = new EncryptedChatEventSealer(
    service,
    binding.chatId,
    { explanation: null, steps: [], question: null },
    resolver,
  );
  const message = {
    id: "answer",
    text: "fixture text",
    phase: "final_answer" as const,
  };
  return { binding, identity, mapping, resolve, service, sealer, message };
}

describe("native output identity selection before encryption", () => {
  it("binds live output lazily, retries an actual binding failure, and retains each dispatched thread scope", async () => {
    const f = fixture();
    const secondThread = randomUUID();
    const open = vi
      .fn<NativeHistoryClient["open"]>()
      .mockImplementation(async (scope) => ({
        ...f.binding,
        threadId: scope.threadId,
      }));
    open.mockRejectedValueOnce(new Error("fixture binding failure"));
    f.resolve.mockImplementation(async (input) => [
      {
        ...f.mapping,
        identity: input.items[0]!.identity,
        messageId:
          input.items[0]!.identity.threadId === f.binding.threadId
            ? f.mapping.messageId
            : "11111111-1111-4111-8111-111111111111",
      },
    ]);
    const scope = vi.fn((threadId: string) => ({
      chatId: f.binding.chatId,
      threadId,
      provenance: { kind: "current" as const },
    }));
    const resolver = createManagedNativeOutputIdentityResolver({
      client: { open, resolve: f.resolve },
      scope,
    });
    expect(open).not.toHaveBeenCalled();
    const output = (threadId: string) => ({
      kind: "message" as const,
      message: {
        ...f.message,
        correlation: {
          sourceMethod: "item/agentMessage/delta",
          threadId,
          turnId: "turn",
          itemId: "answer",
          diagnosticId: null,
        },
      },
    });
    await expect(resolver(output(f.binding.threadId))).rejects.toThrow(
      "fixture binding failure",
    );
    const first = await resolver(output(f.binding.threadId));
    const second = await resolver(output(secondThread));
    expect(second?.id).not.toBe(first?.id);
    expect(await resolver(output(f.binding.threadId))).toEqual(first);
    expect(scope.mock.calls.map(([threadId]) => threadId)).toEqual([
      f.binding.threadId,
      f.binding.threadId,
      secondThread,
      f.binding.threadId,
    ]);
    expect(open).toHaveBeenCalledTimes(3);
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(
      open.mock.calls.every(([, signal]) => signal instanceof AbortSignal),
    ).toBe(true);
  });

  it("does not relabel synthetic or snapshot output as canonical live items", async () => {
    const f = fixture();
    const open = vi.fn<NativeHistoryClient["open"]>();
    const scope = vi.fn(() => null);
    const resolver = createManagedNativeOutputIdentityResolver({
      client: { open, resolve: f.resolve },
      scope,
    });
    expect(await resolver({ kind: "message", message: f.message })).toBeNull();
    const correlation = {
      sourceMethod: "thread/read",
      threadId: f.binding.threadId,
      turnId: "turn",
      itemId: "answer",
      diagnosticId: null,
    };
    expect(
      await resolver({
        kind: "message",
        message: { ...f.message, correlation },
      }),
    ).toBeNull();
    expect(
      await resolver({
        kind: "message",
        message: {
          ...f.message,
          id: "synthetic-summary",
          correlation: { ...correlation, sourceMethod: "item/completed" },
        },
      }),
    ).toBeNull();
    expect(scope).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await expect(
      resolver({
        kind: "message",
        message: {
          ...f.message,
          correlation: { ...correlation, sourceMethod: "item/completed" },
        },
      }),
    ).rejects.toThrow("missing its dispatched history scope");
    expect(open).not.toHaveBeenCalled();
  });

  it("shares concurrent failure, retries it, and never falls back to a legacy ID", async () => {
    const f = fixture();
    f.resolve.mockRejectedValueOnce(new Error("fixture transport failure"));
    const failed = await Promise.allSettled([
      f.sealer.message(f.message),
      f.sealer.message(f.message),
    ]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(f.resolve).toHaveBeenCalledTimes(1);
    const event = await f.sealer.message(f.message);
    expect(event.message.id).toBe(f.mapping.messageId);
    expect(event.message.idempotencyKey).toBe(f.mapping.idempotencyKey);
    expect((await f.sealer.message(f.message)).message.id).toBe(
      f.mapping.messageId,
    );
    expect(f.resolve).toHaveBeenCalledTimes(2);
  });

  it("rejects unrelated mappings before encryption and can recover on the next call", async () => {
    const f = fixture();
    f.resolve.mockResolvedValueOnce([
      { ...f.mapping, identity: { ...f.identity, turnId: "another-turn" } },
    ]);
    await expect(f.sealer.message(f.message)).rejects.toThrow(
      "unrelated mapping",
    );
    expect((await f.sealer.message(f.message)).message.id).toBe(
      f.mapping.messageId,
    );
    expect(f.resolve).toHaveBeenCalledTimes(2);
  });

  it("retains legacy identity for explicitly auxiliary output without a history request", async () => {
    const f = fixture();
    const plain = new EncryptedChatEventSealer(f.service, f.binding.chatId, {
      explanation: null,
      steps: [],
      question: null,
    });
    const auxiliary = new EncryptedChatEventSealer(
      f.service,
      f.binding.chatId,
      { explanation: null, steps: [], question: null },
      createNativeHistoryOutputIdentityResolver({
        binding: f.binding,
        client: { resolve: f.resolve },
        identity: () => null,
      }),
    );
    const original = await plain.message(f.message);
    const selected = await auxiliary.message(f.message);
    expect(selected.message.id).toBe(original.message.id);
    expect(selected.message.idempotencyKey).toBe(
      original.message.idempotencyKey,
    );
    expect(f.resolve).not.toHaveBeenCalled();
  });
});
