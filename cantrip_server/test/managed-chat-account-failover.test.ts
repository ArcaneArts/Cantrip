import { describe, expect, it, vi } from "vitest";
import type {
  ChatExecutionContext,
  ModelProviderAccountRuntime,
  ModelRuntime,
} from "../src/db/repository.js";
import {
  createManagedChatAccountFailover,
  type ManagedChatAccountFailoverDependencies,
} from "../src/app/runtime/managed-chat-account-failover.js";
import {
  createChatRecoveryRuntime,
  type ChatRecoveryRuntimeDependencies,
} from "../src/app/runtime/chat-recovery-runtime.js";

const credits = { hasCredits: true, unlimited: false, balance: "28439.77" };
const original = {
  contextKind: "project",
  experience: "agent",
  chatId: "chat",
  workerId: "worker",
  threadId: "same-native-thread",
  modelRouteId: "route",
  providerAccountId: "ai",
  executionLaneId: null,
  managedInputRevision: 7,
} as ChatExecutionContext;
const runtime = {
  routeId: "route",
  model: { providerModelId: "gpt-6.1-sol", name: "gpt-6.1-sol" },
  provider: {
    id: "chatgpt",
    kind: "chatgpt",
    name: "ChatGPT",
    weeklyUsageReservePercent: 3,
  },
} as ModelRuntime;
const account = (
  accountId: string,
  overrides: Partial<ModelProviderAccountRuntime> = {},
): ModelProviderAccountRuntime => ({
  accountId,
  credentialState: "signed-in",
  credentialHomeKey: accountId,
  enabled: true,
  legacyWorkerAuthenticated: false,
  modelAvailability: "available",
  position: accountId === "ai" ? 0 : 1,
  weeklyUsageUsedPercent: 100,
  ...overrides,
});

function fixture(accounts = [account("ai"), account("arcane", { credits })]) {
  let context = { ...original };
  const repository = {
    getChatExecutionContext: vi.fn(async () => context),
    getModelRuntimeByRoute: vi.fn(async () => runtime),
    listModelProviderAccountRuntimes: vi.fn(async () => accounts),
    nativeCommands: {
      settingsState: vi.fn(async () => ({
        binding: {
          bindingId: "binding",
          threadId: original.threadId,
          workerId: original.workerId,
          modelRouteId: original.modelRouteId,
          providerAccountId: original.providerAccountId,
        },
      })),
    },
  };
  const handoffRuntime = vi.fn(async () => {
    context = { ...context, providerAccountId: "arcane" };
  });
  return {
    repository,
    handoffRuntime,
    get context() {
      return context;
    },
    set context(value) {
      context = value;
    },
    switchAccount: createManagedChatAccountFailover({
      repository,
      handoffRuntime,
    } as unknown as ManagedChatAccountFailoverDependencies),
  };
}

describe("managed conversation account failover", () => {
  it("moves a depleted conversation to credits on the same route and native thread", async () => {
    const f = fixture();
    const result = await f.switchAccount("owner", original, 7);
    expect(result).toEqual({ ...original, providerAccountId: "arcane" });
    expect(f.handoffRuntime).toHaveBeenCalledExactlyOnceWith("owner", "chat", {
      operationId: expect.any(String),
      bindingId: "binding",
      targetModelRouteId: "route",
      targetProviderAccountId: "arcane",
    });
    expect(
      f.repository.listModelProviderAccountRuntimes,
    ).toHaveBeenCalledExactlyOnceWith(
      "owner",
      "chatgpt",
      "worker",
      "gpt-6.1-sol",
    );
  });

  it("can use another account's weekly allowance without credits", async () => {
    const f = fixture([
      account("ai"),
      account("arcane", { weeklyUsageUsedPercent: 40 }),
    ]);
    expect(
      (await f.switchAccount("owner", original, 7)).providerAccountId,
    ).toBe("arcane");
  });

  it.each([
    { credits },
    { credits: { hasCredits: true, unlimited: true, balance: null } },
    { weeklyUsageUsedPercent: 70 },
    { weeklyUsageUsedPercent: null },
  ])(
    "keeps an account with credits, remaining quota, or unknown quota (%j)",
    async (overrides) => {
      const f = fixture([
        account("ai", overrides),
        account("arcane", { credits }),
      ]);
      expect(await f.switchAccount("owner", original, 7)).toEqual(original);
      expect(f.handoffRuntime).not.toHaveBeenCalled();
    },
  );

  it.each([
    { enabled: false },
    { credentialState: "signed-out" as const },
    { modelAvailability: "unavailable" as const },
    { credits: { ...credits, balance: "100" } },
    { credits: null },
  ])(
    "still attempts the current account when the alternative cannot be selected (%j)",
    async (overrides) => {
      const f = fixture([
        account("ai"),
        account("arcane", { credits, ...overrides }),
      ]);
      expect(await f.switchAccount("owner", original, 7)).toEqual(original);
      expect(f.handoffRuntime).not.toHaveBeenCalled();
    },
  );

  it.each([
    { managedInputRevision: 8 },
    { executionLaneId: "active-lane" },
    { threadId: null },
    { contextKind: "standalone" as const },
    { experience: "task" as const },
  ])(
    "does not move stale, active, or unmanaged input (%j)",
    async (changes) => {
      const f = fixture();
      f.context = { ...original, ...changes } as ChatExecutionContext;
      expect(await f.switchAccount("owner", original, 7)).toEqual(f.context);
      expect(f.handoffRuntime).not.toHaveBeenCalled();
    },
  );

  it("joins a concurrent transfer and reloads the canonical account on subsequent input", async () => {
    const f = fixture();
    let release!: () => void;
    f.handoffRuntime.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      f.context = { ...original, providerAccountId: "arcane" };
    });
    const first = f.switchAccount("owner", original, 7);
    const second = f.switchAccount("owner", original, 7);
    await vi.waitFor(() => expect(f.handoffRuntime).toHaveBeenCalledOnce());
    release();
    expect(await first).toEqual(await second);
    expect(
      (await f.switchAccount("owner", original, 7)).providerAccountId,
    ).toBe("arcane");
    expect(f.handoffRuntime).toHaveBeenCalledOnce();
  });

  it("does not override a manual account change while selecting an automatic replacement", async () => {
    const f = fixture();
    f.repository.nativeCommands.settingsState.mockImplementationOnce(
      async () => {
        f.context = { ...original, providerAccountId: "manual-selection" };
        return {
          binding: {
            bindingId: "new-binding",
            threadId: original.threadId,
            workerId: original.workerId,
            modelRouteId: original.modelRouteId,
            providerAccountId: "manual-selection",
          },
        };
      },
    );
    expect(
      (await f.switchAccount("owner", original, 7)).providerAccountId,
    ).toBe("manual-selection");
    expect(f.handoffRuntime).not.toHaveBeenCalled();
  });

  it("does not treat a failed native transfer as a successful switch", async () => {
    const f = fixture();
    f.handoffRuntime.mockRejectedValueOnce(
      new Error("actual worker transfer failed"),
    );
    await expect(f.switchAccount("owner", original, 7)).rejects.toThrow(
      "actual worker transfer failed",
    );
    expect(f.context).toEqual(original);
    expect(
      (await f.switchAccount("owner", original, 7)).providerAccountId,
    ).toBe("arcane");
  });

  it.each([true, false])(
    "finishes the account transfer before claiming queued input (success: %s)",
    async (success) => {
      const context = { ...original, status: "idle", automationPaused: false };
      const transferred = { ...context, providerAccountId: "arcane" };
      const prompt = {
        id: "queued-prompt",
        frozen: false,
        classification: { mode: "default", attachmentIds: [] },
        pendingMessage: { id: "message", idempotencyKey: "message" },
      };
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prepare = vi.fn(async () => {
        await barrier;
        if (!success) throw new Error("Actual transfer failed");
        return transferred;
      });
      const claim = vi.fn(async () => ({
        id: "claim",
        promptId: prompt.id,
        promptRevision: 1,
      }));
      const beginTurn = vi.fn(async () => {});
      const error = vi.fn();
      const recovery = createChatRecoveryRuntime({
        applicationOwnerId: () => "owner",
        app: { log: { info() {}, error } },
        repository: {
          getChatExecutionContext: async () => context,
          listEncryptedQueuedPrompts: async () => [prompt],
          getEncryptedQueuedPrompt: async () => prompt,
          managedQueue: { claimNext: claim },
        },
        prepareQueuedAccount: prepare,
        beginTurn,
      } as unknown as ChatRecoveryRuntimeDependencies);
      const pending = recovery.dispatchNextQueuedPrompt("chat");
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      expect(claim).not.toHaveBeenCalled();
      expect(beginTurn).not.toHaveBeenCalled();
      release();
      await pending;
      if (success) {
        expect(claim).toHaveBeenCalledExactlyOnceWith("owner", "chat");
        expect(beginTurn).toHaveBeenCalledExactlyOnceWith(
          transferred,
          expect.any(Object),
          expect.objectContaining({
            managedQueueClaim: { id: "claim", promptRevision: 1 },
          }),
        );
        expect(error).not.toHaveBeenCalled();
      } else {
        expect(claim).not.toHaveBeenCalled();
        expect(beginTurn).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledOnce();
      }
    },
  );
});
