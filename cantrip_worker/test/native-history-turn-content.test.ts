import { describe, expect, it } from "vitest";
import {
  openNativeHistoryTurn,
  prepareNativeHistoryTurn,
  protectNativeHistoryTurnMetadata,
} from "../src/native-history-turn-content.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";
import { decryptNativeHistoryTurn } from "@cantrip/crypto";

const binding = {
  id: "binding",
  workerId: "worker",
  chatId: "chat",
  threadId: "thread",
};
const key = new Uint8Array(32).fill(21);
function service(owner = "owner", server = "server", currentRevision = 1) {
  return {
    ownerId: () => owner,
    serverIdentity: () => server,
    componentKey: (_scope: string, revision = currentRevision) => {
      if (![1, 2].includes(revision))
        throw new Error("Unavailable key revision");
      return { key: key.map((byte) => byte + revision), keyRevision: revision };
    },
  };
}
const usage = {
  totalTokens: 13,
  inputTokens: 8,
  outputTokens: 5,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 1,
};
function snapshot() {
  return parseCodexNativeHistory(
    {
      thread: {
        id: binding.threadId,
        parentThreadId: "parent",
        forkedFromId: null,
        status: { type: "idle" },
        turns: [
          {
            id: "turn",
            status: "completed",
            itemsView: "full",
            startedAt: 1_788_000_000,
            completedAt: 1_788_000_002,
            durationMs: 1_750,
            error: null,
            futureTurnField: { detail: "private native extension" },
            items: [
              {
                type: "agentMessage",
                id: "answer",
                text: "protected separately",
              },
            ],
          },
        ],
      },
      history: {
        version: 1,
        currentTurnId: null,
        currentTurnState: "notLoaded",
        turns: [
          {
            turnId: "turn",
            source: "canonical",
            retention: "partial",
            initialSettings: {
              model: "private-initial-model",
              modelProvider: "private-initial-provider",
              reasoningEffort: null,
              effectiveReasoningEffort: "high",
              serviceTier: "default",
              effectiveServiceTier: null,
              collaborationMode: "plan",
            },
            contexts: [
              {
                cwd: "/private-original-workspace",
                model: "fixture-model",
                collaborationMode: "plan",
                reasoningEffort: "high",
                rootTurnId: "parent-turn",
              },
            ],
            items: [
              {
                itemId: "answer",
                state: "completed",
                startedAtMs: null,
                completedAtMs: null,
              },
            ],
            usage: {
              responses: [
                {
                  responseId: "response",
                  threadId: "thread",
                  sessionId: "session",
                  rootTurnId: "parent-turn",
                  usage,
                },
              ],
              total: usage,
              conflictingResponseIds: [],
            },
            warnings: ["private warning"],
            errors: [],
            futureEvidence: "preserved",
          },
        ],
      },
    },
    binding.threadId,
  );
}

async function prepare() {
  return prepareNativeHistoryTurn({
    service: service(),
    binding,
    snapshot: snapshot(),
    turnId: "turn",
    revision: 7,
  });
}

describe("worker-protected native turn aggregates", () => {
  it("authenticates public usage in worker and browser decoders while retaining legacy envelopes", async () => {
    const turn = await prepare();
    const browser = (candidate: typeof turn) =>
      decryptNativeHistoryTurn({
        ownerId: "owner",
        serverId: "server",
        componentKey: key.map((byte) => byte + 1),
        chatId: binding.chatId,
        bindingId: binding.id,
        workerId: binding.workerId,
        turn: candidate,
      });
    expect(await browser(turn)).toEqual(
      await openNativeHistoryTurn({ service: service(), binding, turn }),
    );
    const changed = structuredClone(turn);
    changed.usage!.responses[0]!.usage.outputTokens++;
    await expect(browser(changed)).rejects.toThrow();
    await expect(
      openNativeHistoryTurn({ service: service(), binding, turn: changed }),
    ).rejects.toThrow();
    const { usage: _usage, ...removed } = turn;
    await expect(browser(removed)).rejects.toThrow();
    const { metadata: _metadata, ...header } = removed;
    const legacy = await protectNativeHistoryTurnMetadata({
      service: service(),
      binding,
      header,
      content: { version: 1, legacy: true },
    });
    expect(await browser(legacy)).toEqual({ version: 1, legacy: true });
    await expect(browser({ ...legacy, usage: turn.usage })).rejects.toThrow();
  });
  it("preserves usage, scope, errors, unknown native fields and original duration without plaintext publication", async () => {
    const turn = await prepare();
    expect(turn).toMatchObject({
      revision: 7,
      startedAtMs: 1_788_000_000_000,
      completedAtMs: 1_788_000_002_000,
    });
    expect(JSON.stringify(turn)).not.toContain("private");
    expect(turn.usage).toMatchObject({
      responses: [{ responseId: "response", usage }],
      complete: false,
    });
    expect(turn).not.toHaveProperty("initialSettings");
    const opened = await openNativeHistoryTurn({
      service: service(),
      binding,
      turn,
    });
    expect(opened).toEqual({
      version: 1,
      parentThreadId: "parent",
      forkedFromId: null,
      nativeTurn: {
        id: "turn",
        status: "completed",
        itemsView: "full",
        error: null,
        startedAt: 1_788_000_000,
        completedAt: 1_788_000_002,
        durationMs: 1_750,
        futureTurnField: { detail: "private native extension" },
      },
      history: snapshot().history!.turns[0],
    });
    expect(key).toEqual(new Uint8Array(32).fill(21));
  });

  it("keeps unavailable evidence and unloaded item state explicit instead of fabricating timing or usage", async () => {
    const source = snapshot();
    source.history = null;
    source.thread.turns[0]!.startedAt = null;
    source.thread.turns[0]!.completedAt = null;
    source.thread.turns[0]!.durationMs = null;
    source.thread.turns[0]!.itemsView = "notLoaded";
    source.thread.turns[0]!.items = [];
    const turn = await prepareNativeHistoryTurn({
      service: service(),
      binding,
      snapshot: source,
      turnId: "turn",
      revision: 1,
    });
    expect(turn.startedAtMs).toBeNull();
    expect(turn.completedAtMs).toBeNull();
    expect(
      await openNativeHistoryTurn({ service: service(), binding, turn }),
    ).toMatchObject({
      history: null,
      nativeTurn: { itemsView: "notLoaded", durationMs: null },
    });
  });

  it.each([
    { revision: 8 },
    { turnId: "other-turn" },
    { ordinal: 3 },
    { status: "failed" as const },
    { startedAtMs: null },
    { completedAtMs: 5 },
  ])("authenticates public turn attribution %j", async (change) => {
    const turn = await prepare();
    await expect(
      openNativeHistoryTurn({
        service: service(),
        binding,
        turn: { ...turn, ...change },
      }),
    ).rejects.toThrow();
  });

  it("rejects cross-owner/server/worker/chat/binding/thread substitution, even with identical key material", async () => {
    const turn = await prepare();
    for (const changed of [service("other"), service("owner", "other")])
      await expect(
        openNativeHistoryTurn({ service: changed, binding, turn }),
      ).rejects.toThrow();
    for (const change of [
      { id: "other" },
      { chatId: "other" },
      { workerId: "other" },
    ])
      await expect(
        openNativeHistoryTurn({
          service: service(),
          binding: { ...binding, ...change },
          turn,
        }),
      ).rejects.toThrow();
    await expect(
      openNativeHistoryTurn({
        service: service(),
        binding: { ...binding, threadId: "other" },
        turn: { ...turn, threadId: "other" },
      }),
    ).rejects.toThrow();
  });

  it("opens retained metadata after key rotation and detects ciphertext tampering", async () => {
    const turn = await prepare();
    expect(
      await openNativeHistoryTurn({
        service: service("owner", "server", 2),
        binding,
        turn,
      }),
    ).toMatchObject({ version: 1 });
    await expect(
      openNativeHistoryTurn({
        service: service(),
        binding,
        turn: {
          ...turn,
          metadata: { ...turn.metadata, ciphertext: "AAAAAAAAAAAAAAAAAAAAAA" },
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects a missing turn or unrelated observed thread without preparing content", async () => {
    await expect(
      prepareNativeHistoryTurn({
        service: service(),
        binding,
        snapshot: snapshot(),
        turnId: "missing",
        revision: 1,
      }),
    ).rejects.toThrow("does not contain");
    await expect(
      prepareNativeHistoryTurn({
        service: service(),
        binding: { ...binding, threadId: "other" },
        snapshot: snapshot(),
        turnId: "turn",
        revision: 1,
      }),
    ).rejects.toThrow("different binding");
  });
});
