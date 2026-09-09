import { describe, expect, it, vi } from "vitest";
import { deriveFieldKey, encryptPayload } from "@cantrip/crypto";
import type {
  ChatMessage,
  NativeHistoryTurnReadResponse,
  NativeInitialTurnSettings,
} from "@cantrip/protocol";
const runtime = vi.hoisted(() => ({
  request: vi.fn(),
  service: null as unknown,
  matches: vi.fn(() => true),
}));
vi.mock("./api-client", () => ({ request: runtime.request }));
vi.mock("./client-encryption", () => ({
  get clientEncryption() {
    return runtime.service;
  },
  ClientEncryptionError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./client-session", () => ({
  clientSessionIdentityMatches: runtime.matches,
}));
import type { ClientEncryptionService } from "./client-encryption";
import {
  enrichNativeTurnSummaries,
  nativeSummaryTurnIdentities,
  openNativeTurnSettings,
  readNativeTurnSettings,
} from "./native-history-turn-settings";
const identity = {
  userId: "owner",
  serverId: "server",
  accountId: "account",
  connectionId: "connection",
  generation: 1,
  incarnationId: "incarnation",
  serverUrl: null,
};
const initial: NativeInitialTurnSettings = {
  model: "native-model",
  modelProvider: "native-provider",
  reasoningEffort: null,
  effectiveReasoningEffort: "high",
  serviceTier: null,
  effectiveServiceTier: "fast",
  collaborationMode: "plan",
};
function fixture() {
  let snapshot = {
    status: "ready",
    identity: { ownerId: "owner", serverId: "server" },
    masterKeyRevision: 2,
  };
  const keys: Uint8Array[] = [];
  const service = {
    getSnapshot: () => snapshot,
    componentKey: () => {
      const key = new Uint8Array(32).fill(21);
      keys.push(key);
      return key;
    },
  } as unknown as ClientEncryptionService;
  runtime.service = service;
  runtime.matches.mockReturnValue(true);
  return {
    options: { service, identityMatches: runtime.matches },
    keys,
    lock: () => {
      snapshot = { ...snapshot, status: "locked" };
    },
  };
}
async function archived(
  content: unknown,
  source = { bindingId: "binding", workerId: "worker", revision: 1 },
) {
  const header = {
    threadId: "thread",
    turnId: "turn",
    revision: source.revision,
    ordinal: 0,
    status: "completed" as const,
    startedAtMs: 1000,
    completedAtMs: 2000,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        "server",
        source.workerId,
        "chat",
        source.bindingId,
        header.threadId,
        header.turnId,
        header.revision,
        header.ordinal,
        header.status,
        header.startedAtMs,
        header.completedAtMs,
      ]),
    ),
  );
  const associatedData = {
    ownerId: "owner",
    component: "chat-content" as const,
    table: "native-history-turns",
    rowId: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    field: "metadata",
    formatVersion: 1 as const,
    keyRevision: 2,
  };
  const key = deriveFieldKey({
    componentKey: new Uint8Array(32).fill(21),
    ...associatedData,
  });
  const metadata = await encryptPayload({
    key,
    associatedData,
    plaintext: new TextEncoder().encode(JSON.stringify(content)),
  });
  key.fill(0);
  return {
    bindingId: source.bindingId,
    workerId: source.workerId,
    turn: { ...header, metadata },
  };
}
const source = (
  settings: NativeInitialTurnSettings | undefined = initial,
  conflicts: unknown[] = [],
) => ({
  version: 2,
  reducedTurn: {
    id: "turn",
    metadata: settings ? { initialSettings: settings } : {},
    conflicts,
  },
  evidence: [],
});
const response = (
  ...turns: NativeHistoryTurnReadResponse["turns"]
): NativeHistoryTurnReadResponse => ({ chatId: "chat", turns });
const open = (turns: NativeHistoryTurnReadResponse, context = fixture()) =>
  openNativeTurnSettings({
    chatId: "chat",
    response: turns,
    identity,
    options: context.options,
  });
const summary = (settings?: NativeInitialTurnSettings) =>
  ({
    id: "message",
    role: "assistant",
    content: [
      {
        type: "activity",
        activity: {
          type: "turnSummary",
          id: "turn:turn:summary",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
          correlation: {
            sourceMethod: "turn/completed",
            threadId: "thread",
            turnId: "turn",
            itemId: null,
            diagnosticId: null,
          },
          ...(settings ? { initialSettings: settings } : {}),
        },
      },
    ],
  }) as ChatMessage;
describe("historical native turn settings adapter", () => {
  it("reconciles exact immutable settings across replaced worker archives and older omitted snapshots", async () => {
    const old = await archived({
      version: 1,
      nativeTurn: { id: "turn" },
      history: { turnId: "turn" },
    });
    const current = await archived(source(), {
      bindingId: "replacement",
      workerId: "replacement-worker",
      revision: 1,
    });
    const context = fixture();
    expect(await open(response(old, current), context)).toEqual([
      {
        threadId: "thread",
        turnId: "turn",
        status: "available",
        initialSettings: initial,
      },
    ]);
    expect(context.keys.every((key) => key.every((byte) => byte === 0))).toBe(
      true,
    );
  });
  it("retains conflict evidence independent of binding revision and does not revive it on later reads", async () => {
    const conflict = await archived(
      source(undefined, [{ initialSettingsConflict: true }]),
      { bindingId: "older", workerId: "older-worker", revision: 99 },
    );
    const current = await archived(source());
    expect(await open(response(conflict, current))).toEqual([
      { threadId: "thread", turnId: "turn", status: "conflict" },
    ]);
    const different = await archived(
      source({ ...initial, model: "different-native" }),
      { bindingId: "other", workerId: "other-worker", revision: 1 },
    );
    expect((await open(response(current, different)))[0]!.status).toBe(
      "conflict",
    );
    const original = summary(initial);
    const conflicted = enrichNativeTurnSummaries(
      [original],
      [{ threadId: "thread", turnId: "turn", status: "conflict" }],
    );
    expect(JSON.stringify(conflicted)).not.toContain('"initialSettings":');
    expect(
      JSON.stringify(
        enrichNativeTurnSummaries(conflicted, [
          {
            threadId: "thread",
            turnId: "turn",
            status: "available",
            initialSettings: initial,
          },
        ]),
      ),
    ).not.toContain('"initialSettings":');
  });
  it("enriches existing summaries without adding messages or regressing lifecycle; legacy omissions retain live capture", async () => {
    const original = summary();
    const messages = [
      original,
      {
        id: "user",
        role: "user",
        content: [{ type: "text", text: "actual input" }],
      } as ChatMessage,
    ];
    const enriched = enrichNativeTurnSummaries(
      messages,
      await open(response(await archived(source()))),
    );
    expect(enriched).toHaveLength(2);
    expect(enriched[1]).toBe(messages[1]);
    expect(enriched[0]!.id).toBe(original.id);
    expect(enriched[0]!.content[0]).toMatchObject({
      activity: {
        status: "completed",
        durationMs: 1000,
        initialSettings: initial,
      },
    });
    const live = summary(initial);
    expect(
      enrichNativeTurnSummaries(
        [live],
        [{ threadId: "thread", turnId: "turn", status: "unavailable" }],
      )[0],
    ).toBe(live);
    expect(
      nativeSummaryTurnIdentities([original, original, messages[1]!]),
    ).toEqual([{ threadId: "thread", turnId: "turn" }]);
  });
  it("rejects another chat, relabeled binding or source turn and lock during decryption", async () => {
    const good = await archived(source());
    await expect(
      open({ ...response(good), chatId: "other-chat" }),
    ).rejects.toThrow("another chat");
    await expect(
      open(response({ ...good, bindingId: "relabeled" })),
    ).rejects.toThrow();
    await expect(
      open(
        response(
          await archived({
            version: 2,
            reducedTurn: { id: "other-turn", metadata: {}, conflicts: [] },
          }),
        ),
      ),
    ).rejects.toThrow("another native turn");
    const context = fixture();
    const pending = open(response(good), context);
    context.lock();
    await expect(pending).rejects.toThrow("encryption session changed");
    expect(context.keys[0]!.every((byte) => byte === 0)).toBe(true);
  });
  it("processes all requested turns in bounded archive batches", async () => {
    fixture();
    const last = await archived(source());
    const turns = [
      ...Array.from({ length: 66 }, (_, index) => ({
        threadId: "thread",
        turnId: `old-${index}`,
      })),
      { threadId: "thread", turnId: "turn" },
    ];
    runtime.request.mockReset().mockImplementation(async (_path, options) => {
      const batch = JSON.parse(options.body).turns as typeof turns;
      return batch.some((turn) => turn.turnId === "turn")
        ? response(last)
        : response();
    });
    expect(
      await readNativeTurnSettings({ chatId: "chat", turns, identity }),
    ).toEqual([
      {
        threadId: "thread",
        turnId: "turn",
        status: "available",
        initialSettings: initial,
      },
    ]);
    const batches = runtime.request.mock.calls.map(
      (call) => JSON.parse(call[1].body).turns as typeof turns,
    );
    expect(batches.map((batch) => batch.length)).toEqual([32, 32, 3]);
    expect(batches.flat()).toEqual(turns);
  });
  it("aborts before requesting subsequent archive batches", async () => {
    fixture();
    const controller = new AbortController();
    const turns = Array.from({ length: 65 }, (_, index) => ({
      threadId: "thread",
      turnId: `turn-${index}`,
    }));
    runtime.request.mockReset().mockImplementation(async () => {
      controller.abort();
      return response();
    });
    await expect(
      readNativeTurnSettings({
        chatId: "chat",
        turns,
        identity,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.request).toHaveBeenCalledOnce();
    expect(runtime.request.mock.calls[0]![1].signal).toBe(controller.signal);
  });
  it("pins the bulk request to the authenticated session and rejects unrequested tuples", async () => {
    fixture();
    runtime.request
      .mockReset()
      .mockResolvedValue(response(await archived(source())));
    const turns = [{ threadId: "thread", turnId: "turn" }];
    expect(
      (await readNativeTurnSettings({ chatId: "chat", turns, identity }))[0]!
        .status,
    ).toBe("available");
    expect(runtime.request).toHaveBeenCalledExactlyOnceWith(
      "/api/chats/chat/native-history/turns/read",
      { method: "POST", body: JSON.stringify({ turns }), signal: undefined },
      { expectedIdentity: identity },
    );
    await expect(
      readNativeTurnSettings({
        chatId: "chat",
        turns: [{ threadId: "other", turnId: "turn" }],
        identity,
      }),
    ).rejects.toThrow("unrequested");
  });
});
