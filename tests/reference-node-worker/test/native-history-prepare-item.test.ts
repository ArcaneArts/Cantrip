import { describe, expect, it } from "vitest";
import type { NativeHistoryItemMapping } from "@cantrip/protocol";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
import { protectChatMessage } from "../src/chat-message-encryption.js";
import { prepareNativeHistoryRenderedItem } from "../src/native-history-prepare-item.js";
import { renderNativeHistoryItem } from "../src/native-history-render.js";
import { openNativeHistoryItemEvidence } from "../src/native-history-item-content.js";
import { nativeHistoryStateItemSchema } from "../src/native-history-state.js";

const binding = {
  id: "binding",
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
};
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ key: new Uint8Array(32).fill(91), keyRevision: 1 }),
} as WorkerEncryptionService;
function fixture() {
  const source = nativeHistoryStateItemSchema.parse({
    id: "input",
    identityKind: "canonical",
    revision: 3,
    ordinal: 0,
    body: {
      id: "input",
      type: "userMessage",
      clientId: "native-client",
      content: [{ type: "text", text: "transformed native input" }],
    },
    lifecycle: "completed",
    completeBody: true,
    startedAtMs: null,
    completedAtMs: null,
    origin: { kind: "notification", generation: "runtime", sequence: 1 },
    conflicts: [],
  });
  const rendered = renderNativeHistoryItem(source, {
    threadId: "thread",
    turnId: "turn",
    cwd: "/fixture",
    mode: "default",
  })[0]!;
  const mapping: NativeHistoryItemMapping = {
    key: "a".repeat(64),
    identity: rendered.identity,
    messageId: "b1a17892-10b4-4a77-b03a-471d226eb02c",
    idempotencyKey: "original",
    preservedInput: null,
  };
  return {
    service,
    binding,
    rendered,
    mapping,
    revision: 4,
    order: { turn: 0, item: 0, component: 0 },
    attachments: [],
  };
}

describe("protected native history draft preparation", () => {
  it("keeps the exact original GUI ciphertext while archiving the transformed native input separately", async () => {
    const input = fixture();
    input.mapping.preservedInput = await protectChatMessage({
      id: input.mapping.messageId,
      service,
      message: {
        role: "user",
        mode: "default",
        idempotencyKey: "original",
        content: [{ type: "text", text: "original GUI input" }],
      },
    });
    const prepared = await prepareNativeHistoryRenderedItem(input);
    expect(prepared.message).toEqual(input.mapping.preservedInput);
    expect(prepared.revision).toBe(4);
    expect(prepared.evidence!.revision).toBe(4);
    expect(
      await openNativeHistoryItemEvidence({
        service,
        binding,
        identity: prepared.identity,
        evidence: prepared.evidence!,
      }),
    ).toEqual(input.rendered.source);
  });

  it("rejects mappings for another item and preserved input with another message identity", async () => {
    const unrelated = fixture();
    unrelated.mapping = {
      ...unrelated.mapping,
      identity: { ...unrelated.mapping.identity, itemId: "other" },
    };
    await expect(prepareNativeHistoryRenderedItem(unrelated)).rejects.toThrow(
      "unrelated item mapping",
    );
    const wrongMessage = fixture();
    wrongMessage.mapping.preservedInput = await protectChatMessage({
      id: "a950c03c-4c40-41d6-bc39-b322a3d01bd6",
      service,
      message: {
        role: "user",
        idempotencyKey: "original",
        content: [{ type: "text", text: "other" }],
      },
    });
    await expect(
      prepareNativeHistoryRenderedItem(wrongMessage),
    ).rejects.toThrow("canonical message mapping");
  });
});
