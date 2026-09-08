import { describe, expect, it, vi } from "vitest";
import {
  createChatThreadSyncRuntime,
  type ChatThreadSyncRuntimeDependencies,
} from "../src/app/runtime/chat-thread-sync-runtime.js";
import {
  createModelRoutingRuntime,
  type ModelRoutingRuntimeDependencies,
} from "../src/app/runtime/model-routing-runtime.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
} from "../src/db/repository.js";

const root: ModelRuntime = {
  routeId: "root-route",
  model: {
    id: "root",
    profileName: "Root",
    routeId: "root-route",
    name: "root-native",
    reasoningEffort: null,
    providerModelId: null,
    catalog: null,
  },
  provider: {
    id: "provider",
    name: "Fixture",
    kind: "openai-compatible",
    baseUrl: "https://provider.example.test/v1",
    protectedApiKey: null,
    accountId: null,
    credentialHomeKey: null,
    weeklyUsageReservePercent: 0,
  },
};
const context: ChatExecutionContext = {
  automationPaused: false,
  chatId: "chat",
  computerUseEnabled: false,
  cwd: "/workspace",
  experience: "agent",
  executionLaneId: null,
  isPrimary: false,
  status: "ready",
  modelId: "root",
  reasoningEffort: null,
  modelConfiguration: {
    modelId: "root",
    reasoningEffort: null,
    customSubagentModel: true,
    subagentModelId: "unavailable-child",
    subagentReasoningEffort: "high",
  },
  modelRouteId: root.routeId,
  providerAccountId: null,
  permissionProfileId: null,
  defaultPermissionProfileId: ":workspace",
  planMode: "plan",
  threadId: "native-thread",
  workerId: "worker",
  contextKind: "project",
  projectId: "project",
  rootKind: "git-worktree",
  scratchRootId: null,
  worktreeId: "worktree",
  worktreeMode: "pinned",
  worktreePolicy: "agent-managed",
};

describe("observational custom-child thread reconciliation", () => {
  it.each(["requested", "notified"])(
    "sends a %s history read when actual child execution routing fails",
    async (source) => {
      const history = { threadId: context.threadId, status: "idle", turns: [] };
      const bridge = {
        isConnected: () => true,
        request: vi.fn().mockResolvedValue(history),
      };
      const repository = {
        getChatExecutionContext: vi.fn().mockResolvedValue(context),
        getModelRuntimeByRoute: vi.fn().mockResolvedValue(root),
        getModelRuntimes: vi.fn(async (_owner: string, modelId: string) =>
          modelId === "root" ? [root] : [],
        ),
        getWorker: vi.fn().mockResolvedValue({
          codexRuntime: {
            nativeSubagents: {
              available: true,
              protocolVersion: 1,
              reason: null,
            },
          },
        }),
      };
      const routing = createModelRoutingRuntime({
        app: { log: { warn: vi.fn() } },
        applicationOwnerId: () => "owner",
        bridge,
        repository,
        openRouterRuntimeCatalogs: {
          hydrate: vi.fn().mockResolvedValue(false),
        },
        routeCooldowns: new Map(),
        runtimeCooldownKey: (runtime: ModelRuntime) => runtime.routeId,
        publishProjectTokenUsageChange: vi.fn(),
      } as unknown as ModelRoutingRuntimeDependencies);
      try {
        // Establish the actual failure through production route selection, with a
        // healthy root and no child route. The reconciler itself remains unmocked.
        await expect(
          routing.routePairsForConfiguration(
            context,
            context.modelConfiguration,
            [root],
          ),
        ).rejects.toMatchObject({
          failure: { code: "subagent-model-unavailable" },
        });
        const childQueriesBefore =
          repository.getModelRuntimes.mock.calls.filter(
            ([, modelId]) => modelId === "unavailable-child",
          ).length;
        const sync = createChatThreadSyncRuntime({
          ...routing,
          applicationOwnerId: () => "owner",
          bridge,
          repository,
          continuePendingWorktreeTransition: vi.fn(),
          dispatchNextQueuedPrompt: vi.fn(),
          publishChatInvalidation: vi.fn(),
          publishChatSummary: vi.fn(),
          upsertLiveChatMessage: vi.fn(),
        } as unknown as ChatThreadSyncRuntimeDependencies);
        if (source === "requested") {
          await expect(sync.reconcileChatThread(context)).resolves.toEqual(
            history,
          );
        } else {
          await sync.reconcileObservedChatThread(
            "chat",
            "worker",
            "native-thread",
            ["plan"],
          );
        }
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith("worker", {
          type: "chat.sync",
          executionProfile: "ide",
          chatId: "chat",
          cwd: "/workspace",
          threadId: "native-thread",
          model: root.model,
          provider: root.provider,
        });
        expect(bridge.request.mock.calls[0]![1]).not.toHaveProperty(
          "subagentDefaults",
        );
        expect(
          repository.getModelRuntimes.mock.calls.filter(
            ([, modelId]) => modelId === "unavailable-child",
          ),
        ).toHaveLength(childQueriesBefore);
      } finally {
        routing.close();
      }
    },
  );
});
