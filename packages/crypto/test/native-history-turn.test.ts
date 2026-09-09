import { describe, expect, it } from "vitest";
import { protectNativeHistoryTurnMetadata } from "../../../cantrip_worker/src/native-history-turn-content.js";
import { decryptNativeHistoryTurn } from "../src/native-history-turn.js";
const binding = {
  id: "binding",
  workerId: "worker",
  chatId: "chat",
  threadId: "thread",
};
const header = {
  threadId: "thread",
  turnId: "turn",
  ordinal: 0,
  revision: 1,
  status: "completed" as const,
  startedAtMs: 1000,
  completedAtMs: 2000,
};
const source = {
  version: 2,
  reducedTurn: {
    id: "turn",
    metadata: { initialSettings: { model: "private-model" } },
    conflicts: [],
  },
  evidence: [],
};
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ key: new Uint8Array(32).fill(21), keyRevision: 2 }),
};
const input = () => ({
  ownerId: "owner",
  serverId: "server",
  componentKey: new Uint8Array(32).fill(21),
  chatId: "chat",
  workerId: "worker",
  bindingId: "binding",
});
describe("browser native turn archive format", () => {
  it("opens actual worker-sealed metadata and retains caller key ownership", async () => {
    const material = input();
    const turn = await protectNativeHistoryTurnMetadata({
      service,
      binding,
      header,
      content: source,
    });
    expect(await decryptNativeHistoryTurn({ ...material, turn })).toEqual(
      source,
    );
    expect(material.componentKey.every((byte) => byte === 21)).toBe(true);
  });
  it.each(["ownerId", "serverId", "chatId", "bindingId", "workerId"] as const)(
    "authenticates %s",
    async (field) => {
      const turn = await protectNativeHistoryTurnMetadata({
        service,
        binding,
        header,
        content: source,
      });
      await expect(
        decryptNativeHistoryTurn({ ...input(), [field]: "substitution", turn }),
      ).rejects.toThrow();
    },
  );
  it.each([
    { threadId: "other" },
    { turnId: "other" },
    { status: "failed" as const },
    { revision: 2 },
    { startedAtMs: 1001 },
    { completedAtMs: 2001 },
  ])("authenticates relabeled turn header %o", async (change) => {
    const turn = await protectNativeHistoryTurnMetadata({
      service,
      binding,
      header,
      content: source,
    });
    await expect(
      decryptNativeHistoryTurn({ ...input(), turn: { ...turn, ...change } }),
    ).rejects.toThrow();
  });
});
