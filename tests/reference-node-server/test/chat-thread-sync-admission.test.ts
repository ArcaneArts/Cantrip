import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createChatThreadSyncRuntime,
  type ChatThreadSyncRuntimeDependencies,
} from "../src/app/runtime/chat-thread-sync-runtime.js";
import { LOCAL_USER_ID, type ModelRuntime } from "../src/db/repository.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";

let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

function observation(status: "idle" | "running" | "failed" = "idle") {
  const publishChatSummary = vi.fn();
  const dispatchNextQueuedPrompt = vi.fn();
  const continuePendingWorktreeTransition = vi.fn().mockResolvedValue(false);
  const runtime = createChatThreadSyncRuntime({
    applicationOwnerId: () => LOCAL_USER_ID,
    repository: fixture.repository,
    bridge: {
      isConnected: () => true,
      request: vi.fn().mockResolvedValue({
        threadId: "native-thread",
        status,
        statusSource: "native-thread",
        turns: [],
      }),
    },
    runtimeForContext: async () =>
      ({ model: {}, provider: {} }) as ModelRuntime,
    publishChatSummary,
    dispatchNextQueuedPrompt,
    continuePendingWorktreeTransition,
  } as unknown as ChatThreadSyncRuntimeDependencies);
  return {
    ...runtime,
    publishChatSummary,
    dispatchNextQueuedPrompt,
    continuePendingWorktreeTransition,
  };
}

async function admitGuiTurn() {
  const base = await fixture.input("gui");
  const input = {
    ...base,
    method: "turn/start" as const,
    session: { ...base.session, runtimeGeneration: null, connectionId: null },
    intent: { scope: "thread" as const, settingKeys: [], expectedTurnId: null },
  };
  const result = await fixture.commands.admit(LOCAL_USER_ID, input);
  expect(result.receipt.status).toBe("accepted");
  return { input, receipt: result.receipt };
}

async function dispatchGuiTurn(turn: Awaited<ReturnType<typeof admitGuiTurn>>) {
  return fixture.commands.dispatch(LOCAL_USER_ID, {
    workerId: fixture.workerId,
    operationId: turn.input.operationId,
    operationGeneration: turn.receipt.operationGeneration,
    payloadDigest: turn.input.payloadDigest,
    session: {
      ...turn.input.session,
      runtimeGeneration: "runtime-one",
      connectionId: `gui:${turn.receipt.operationGeneration}`,
    },
  });
}
async function finish(turn: Awaited<ReturnType<typeof admitGuiTurn>>) {
  const current = await fixture.commands.get(
    LOCAL_USER_ID,
    fixture.workerId,
    turn.input.operationId,
    turn.receipt.operationGeneration,
  );
  if (current.status === "accepted") {
    await fixture.commands.finishLogicalGui(
      LOCAL_USER_ID,
      fixture.workerId,
      turn.input.operationId,
      turn.receipt.operationGeneration,
      "failed",
    );
    return;
  }
  await fixture.commands.settle(LOCAL_USER_ID, {
    workerId: fixture.workerId,
    operationId: turn.input.operationId,
    operationGeneration: turn.receipt.operationGeneration,
    status: "applied",
    resultDigest: null,
    protectedResult: null,
    rejectionCode: null,
    executionComplete: true,
  });
}

describe("thread observations during native GUI admission", () => {
  it.each([
    ["before-admission", "idle"],
    ["during-preparation", "idle"],
    ["before-admission", "running"],
    ["during-preparation", "running"],
    ["before-admission", "failed"],
    ["during-preparation", "failed"],
  ] as const)(
    "keeps the first send dispatchable with a %s context and a %s observation",
    async (when, status) => {
      const before = await fixture.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        fixture.chatId,
      );
      const turn = await admitGuiTurn();
      try {
        const context =
          when === "before-admission"
            ? before
            : await fixture.repository.getChatExecutionContext(
                LOCAL_USER_ID,
                fixture.chatId,
              );
        const sync = observation(status);
        await sync.reconcileChatThread(context!);
        const current = await fixture.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          fixture.chatId,
        );
        expect(current?.status).toBe("running");
        expect(current?.executionLaneId).toBe(turn.receipt.executionLaneId);
        const dispatched = await dispatchGuiTurn(turn);
        expect(dispatched.receipt.status).toBe("dispatched");
        expect(sync.dispatchNextQueuedPrompt).not.toHaveBeenCalled();
        expect(sync.continuePendingWorktreeTransition).not.toHaveBeenCalled();
      } finally {
        await finish(turn);
      }
    },
  );

  it("still reconciles a console lifecycle without a native command owner", async () => {
    const idle = (await fixture.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      fixture.chatId,
    ))!;
    const running = observation("running");
    await running.reconcileChatThread(idle);
    const active = (await fixture.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      fixture.chatId,
    ))!;
    expect(active.status).toBe("running");
    expect(active.executionLaneId).not.toBeNull();
    const stopped = observation("idle");
    await stopped.reconcileChatThread(active);
    const current = await fixture.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      fixture.chatId,
    );
    expect(current?.status).toBe("idle");
    expect(current?.executionLaneId).toBeNull();
    expect(
      stopped.continuePendingWorktreeTransition,
    ).toHaveBeenCalledExactlyOnceWith(fixture.chatId);
    expect(stopped.dispatchNextQueuedPrompt).toHaveBeenCalledExactlyOnceWith(
      fixture.chatId,
    );
  });

  it("rejects a stale placement observation without relabeling the current chat", async () => {
    const current = (await fixture.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      fixture.chatId,
    ))!;
    const stale = { ...current, threadId: "replaced-native-thread" };
    const sync = createChatThreadSyncRuntime({
      applicationOwnerId: () => LOCAL_USER_ID,
      repository: fixture.repository,
      bridge: {
        isConnected: () => true,
        request: vi.fn().mockResolvedValue({
          threadId: stale.threadId,
          status: "failed",
          statusSource: "native-thread",
          turns: [],
        }),
      },
      runtimeForContext: async () =>
        ({ model: {}, provider: {} }) as ModelRuntime,
      publishChatSummary: vi.fn(),
    } as unknown as ChatThreadSyncRuntimeDependencies);
    await sync.reconcileChatThread(stale);
    expect(
      (
        await fixture.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          fixture.chatId,
        )
      )?.status,
    ).toBe(current.status);
  });

  it("keeps an admitted native turn active when a prior failed turn is observed", async () => {
    const turn = await admitGuiTurn();
    try {
      await dispatchGuiTurn(turn);
      const context = await fixture.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        fixture.chatId,
      );
      await observation("failed").reconcileChatThread(context!);
      expect(
        (await fixture.commands.controlContext(LOCAL_USER_ID, fixture.chatId))
          .activationGeneration,
      ).toBe(turn.receipt.activationGeneration);
      expect(
        (
          await fixture.repository.getChatExecutionContext(
            LOCAL_USER_ID,
            fixture.chatId,
          )
        )?.status,
      ).toBe("running");
    } finally {
      await finish(turn);
    }
  });
});
