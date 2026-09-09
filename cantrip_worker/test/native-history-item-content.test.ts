import { describe, expect, it } from "vitest";
import { nativeHistoryPreparedBatchSchema } from "@cantrip/protocol";
import {
  protectNativeHistoryItemEvidence,
  openNativeHistoryItemEvidence,
} from "../src/native-history-item-content.js";
import type { NativeHistoryStateItem } from "../src/native-history-state.js";

const binding = {
  id: "binding",
  workerId: "worker",
  chatId: "chat",
  threadId: "thread",
};
const identity = {
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  identityKind: "canonical" as const,
  component: "activity",
};
const source: NativeHistoryStateItem = {
  id: "item",
  identityKind: "canonical",
  revision: 5,
  ordinal: 3,
  lifecycle: "completed",
  completeBody: true,
  startedAtMs: null,
  completedAtMs: null,
  body: {
    id: "item",
    type: "futureItem",
    fullOutput: "synthetic archival text\n".repeat(15_000),
    structured: { nested: [true, null, { data: "preserved" }] },
  },
  origin: { kind: "snapshot", generation: "runtime", sequence: 4 },
  conflicts: [
    {
      body: { type: "futureItem", alternate: "also retained" },
      lifecycle: "completed",
      completeBody: true,
      startedAtMs: null,
      completedAtMs: null,
      origin: { kind: "snapshot", generation: "old-runtime", sequence: 9 },
    },
  ],
};
function service(owner = "owner", server = "server", current = 1) {
  return {
    ownerId: () => owner,
    serverIdentity: () => server,
    componentKey: (_scope: string, revision = current) => ({
      key: new Uint8Array(32).fill(30 + revision),
      keyRevision: revision,
    }),
  };
}

describe("complete protected native item evidence", () => {
  it("round-trips complete unknown fields and conflicts beyond raw-preview limits after key rotation", async () => {
    const evidence = await protectNativeHistoryItemEvidence({
      binding,
      identity,
      service: service(),
      revision: 12,
      source,
    });
    expect(JSON.stringify(evidence)).not.toContain("synthetic archival text");
    expect(evidence.revision).toBe(12); // Projection and source revisions are separate.
    expect(
      await openNativeHistoryItemEvidence({
        binding,
        identity,
        service: service("owner", "server", 2),
        evidence,
      }),
    ).toEqual(source);
  });

  it.each([
    "owner",
    "server",
    "worker",
    "chat",
    "binding",
    "thread",
    "turn",
    "item",
    "component",
    "kind",
    "revision",
  ])(
    "authenticates %s ownership and historical attribution",
    async (change) => {
      const evidence = await protectNativeHistoryItemEvidence({
        binding,
        identity,
        service: service(),
        revision: 12,
        source,
      });
      const context = {
        binding: { ...binding },
        identity: { ...identity },
        service: service(),
        evidence: { ...evidence },
      };
      if (change === "owner") context.service = service("other");
      if (change === "server") context.service = service("owner", "other");
      if (change === "worker") context.binding.workerId = "other";
      if (change === "chat") context.binding.chatId = "other";
      if (change === "binding") context.binding.id = "other";
      if (change === "thread") {
        context.binding.threadId = "other";
        context.identity.threadId = "other";
      }
      if (change === "turn") context.identity.turnId = "other";
      if (change === "item") context.identity.itemId = "other";
      if (change === "component") context.identity.component = "assistant";
      if (change === "kind")
        Object.assign(context.identity, { identityKind: "legacy" });
      if (change === "revision") context.evidence.revision = 13;
      await expect(openNativeHistoryItemEvidence(context)).rejects.toThrow();
    },
  );

  it("rejects a wrong source identity or binding before preparing ciphertext", async () => {
    await expect(
      protectNativeHistoryItemEvidence({
        binding,
        identity,
        service: service(),
        revision: 1,
        source: { ...source, id: "other" },
      }),
    ).rejects.toThrow("historical identity");
    await expect(
      protectNativeHistoryItemEvidence({
        binding: { ...binding, threadId: "other" },
        identity,
        service: service(),
        revision: 1,
        source,
      }),
    ).rejects.toThrow("another history binding");
  });

  it("rejects a prepared batch carrying evidence for a different item revision", async () => {
    const evidence = await protectNativeHistoryItemEvidence({
      binding,
      identity,
      service: service(),
      revision: 1,
      source,
    });
    const batch = {
      items: [
        {
          identity,
          evidence,
          revision: 2,
          state: "completed",
          order: { turn: 0, item: 0, component: 0 },
          attachments: [],
          message: {
            id: "af9177f4-43a5-45cd-90c8-a3aec356c3b8",
            idempotencyKey: "item",
            classification: {
              role: "assistant",
              mode: "default",
              attachmentIds: [],
            },
            protectedContent: {
              formatVersion: 1,
              keyRevision: 1,
              envelope: evidence.content,
            },
            reasoningEffort: null,
          },
        },
      ],
      turns: [],
    };
    const result = nativeHistoryPreparedBatchSchema.safeParse(batch);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["items", 0, "evidence", "revision"] }),
      );
    expect(
      nativeHistoryPreparedBatchSchema.safeParse({
        ...batch,
        items: [{ ...batch.items[0], revision: 1 }],
      }).success,
    ).toBe(true);
  });
});
