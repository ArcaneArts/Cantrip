import { describe, expect, it, vi } from "vitest";
import { managedSessionContextSchema } from "@cantrip/protocol";
import {
  createChatThreadSyncRuntime,
  type ChatThreadSyncRuntimeDependencies,
} from "../src/app/runtime/chat-thread-sync-runtime.js";

import type {
  ChatExecutionContext,
  ModelRuntime,
} from "../src/db/repository.js";
import { resolveModelRoutePairs } from "../src/models/subagent-routing.js";
import {
  prepareManagedConsoleLaunch,
  type ManagedConsoleRouting,
} from "../src/terminals/managed-session.js";

function runtime(id: string): ModelRuntime {
  return {
    routeId: `${id}-route`,
    model: {
      id,
      profileName: id,
      routeId: `${id}-route`,
      name: `${id}-native`,
      reasoningEffort: null,
      providerModelId: null,
      catalog: null,
    },
    provider: {
      id: "provider-1",
      name: "Provider",
      kind: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      protectedApiKey: null,
      accountId: "account-1",
      credentialHomeKey: "credential-home-1",
      weeklyUsageReservePercent: 5,
    },
  };
}

const root = runtime("root");
const child = runtime("child");
const context: ChatExecutionContext = {
  automationPaused: false,
  chatId: "chat-1",
  computerUseEnabled: true,
  cwd: "/workspace/project",
  experience: "agent",
  executionLaneId: "lane-1",
  isPrimary: false,
  status: "ready",
  modelId: "root",
  reasoningEffort: null,
  modelConfiguration: {
    modelId: "root",
    reasoningEffort: null,
    customSubagentModel: true,
    subagentModelId: "child",
    subagentReasoningEffort: null,
  },
  modelRouteId: root.routeId,
  providerAccountId: root.provider.accountId,
  permissionProfileId: null,
  defaultPermissionProfileId: ":workspace",
  planMode: "plan",
  threadId: null,
  workerId: "worker-1",
  contextKind: "project",
  projectId: "project-1",
  rootKind: "git-worktree",
  scratchRootId: null,
  worktreeId: "worktree-1",
  worktreeMode: "pinned",
  worktreePolicy: "agent-managed",
};

function fixture() {
  const bridge = {
    request: vi.fn().mockResolvedValue({ threadId: "native-thread" }),
  };
  const mcpServers = [
    {
      name: "user-mcp",
      enabled: true,
      transport: "stdio",
      command: "fixture-mcp",
      args: [],
      environment: {},
    },
  ];
  const repository = {
    listEffectiveMcpServers: vi.fn().mockResolvedValue(mcpServers),
    setChatModel: vi.fn().mockResolvedValue(undefined),
    updateChatRuntime: vi.fn().mockResolvedValue(undefined),
  };
  const routePairsForConfiguration: ManagedConsoleRouting["routePairsForConfiguration"] =
    vi.fn(async (_context, configuration, roots) =>
      resolveModelRoutePairs({
        configuration,
        rootRuntimes: roots ?? [],
        subagentRuntimes: [child],
      }),
    );
  return {
    bridge,
    repository,
    routePairsForConfiguration,
    ownerId: "owner-1",
    mcpServers,
  };
}

describe("managed console preparation", () => {
  it("reads a bound custom-child thread after child execution routing becomes unavailable", async () => {
    const f = fixture();
    const existing = { ...context, threadId: "existing-thread" };
    const launch = await prepareManagedConsoleLaunch(existing, root, f);
    vi.mocked(f.routePairsForConfiguration).mockRejectedValue(
      new Error("subagent-model-unavailable"),
    );
    f.bridge.request.mockResolvedValue({
      threadId: "existing-thread",
      status: "idle",
      turns: [],
    });
    const sync = createChatThreadSyncRuntime({
      applicationOwnerId: () => f.ownerId,
      bridge: { ...f.bridge, isConnected: () => true },
      repository: f.repository,
      runtimeForContext: async () => root,
      continuePendingWorktreeTransition: vi.fn(),
      dispatchNextQueuedPrompt: vi.fn(),
      publishChatInvalidation: vi.fn(),
      publishChatSummary: vi.fn(),
      recordRuntimeTokenUsage: vi.fn(),
      upsertLiveChatMessage: vi.fn(),
    } as unknown as ChatThreadSyncRuntimeDependencies);
    await sync.reconcileChatThread(existing);
    expect(f.bridge.request).toHaveBeenCalledExactlyOnceWith("worker-1", {
      type: "chat.sync",
      executionProfile: "ide",
      chatId: existing.chatId,
      cwd: existing.cwd,
      threadId: existing.threadId,
      model: launch.model,
      provider: launch.provider,
    });
    expect(f.routePairsForConfiguration).toHaveBeenCalledTimes(1);
    expect(f.repository.updateChatRuntime).not.toHaveBeenCalled();
  });

  it("uses real model pairing and sends the same full configuration to ensure and launch", async () => {
    const f = fixture();
    const launch = await prepareManagedConsoleLaunch(context, root, f);
    const expected = {
      model: root.model,
      provider: root.provider,
      subagentDefaults: { model: child.model, provider: child.provider },
      planMode: "plan",
      permissionProfileId: ":workspace",
      mcpServers: f.mcpServers,
      session: {
        chatId: "chat-1",
        computerUseEnabled: true,
        contextKind: "project",
        projectId: "project-1",
        worktreeId: "worktree-1",
        rootKind: context.rootKind,
        scratchRootId: null,
      },
    };
    expect(f.routePairsForConfiguration).toHaveBeenCalledWith(
      context,
      context.modelConfiguration,
      [root],
    );
    expect(f.bridge.request).toHaveBeenCalledExactlyOnceWith(
      "worker-1",
      {
        type: "chat.thread.ensure",
        cwd: context.cwd,
        threadId: null,
        ...expected,
      },
      { ownerId: "owner-1", timeoutMs: null },
    );
    expect(launch).toEqual({
      type: "codex",
      threadId: "native-thread",
      ...expected,
    });
    expect(managedSessionContextSchema.parse(launch.session)).toEqual(
      expected.session,
    );
    expect(f.repository.updateChatRuntime).toHaveBeenCalledWith(
      "chat-1",
      "worker-1",
      "worktree-1",
      "native-thread",
      root.routeId,
      "ready",
      "account-1",
    );
  });

  it("does not return a launch until canonical thread binding finishes", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const binding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.repository.updateChatRuntime.mockImplementation(async () => {
      entered();
      await binding;
    });
    let returned = false;
    const pending = prepareManagedConsoleLaunch(context, root, f).then(
      (launch) => {
        returned = true;
        return launch;
      },
    );
    await started;
    expect(returned).toBe(false);
    release();
    await expect(pending).resolves.toMatchObject({ threadId: "native-thread" });
  });

  it.each(["native", "binding"])(
    "propagates %s preparation failure without returning a launch",
    async (phase) => {
      const f = fixture();
      if (phase === "native")
        f.bridge.request.mockRejectedValue(
          new Error("MCP initialization failed"),
        );
      else
        f.repository.updateChatRuntime.mockRejectedValue(
          new Error("binding write failed"),
        );
      await expect(
        prepareManagedConsoleLaunch(context, root, f),
      ).rejects.toThrow(
        phase === "native"
          ? "MCP initialization failed"
          : "binding write failed",
      );
      if (phase === "native")
        expect(f.repository.updateChatRuntime).not.toHaveBeenCalled();
    },
  );

  it("attaches an existing thread without configuration writes and preserves inactive custom defaults", async () => {
    const f = fixture();
    const existing = {
      ...context,
      threadId: "existing-thread",
      modelConfiguration: {
        ...context.modelConfiguration,
        customSubagentModel: false,
      },
    };
    const launch = await prepareManagedConsoleLaunch(existing, root, f);
    expect(launch).toMatchObject({
      threadId: "existing-thread",
      subagentDefaults: null,
      planMode: "plan",
    });
    expect(f.bridge.request).not.toHaveBeenCalled();
    expect(f.repository.setChatModel).not.toHaveBeenCalled();
    expect(f.repository.updateChatRuntime).not.toHaveBeenCalled();
    expect(existing.modelConfiguration.subagentModelId).toBe("child");
  });

  it("keeps standalone Chat outside managed agent session and subagent eligibility", async () => {
    const f = fixture();
    const chat: ChatExecutionContext = {
      ...context,
      contextKind: "standalone",
      experience: "agent",
      projectId: null,
      worktreeId: null,
      rootKind: null,
      scratchRootId: "scratch-1",
      scratchRootStatus: "ready",
      worktreeMode: null,
      worktreePolicy: null,
    };
    await expect(prepareManagedConsoleLaunch(chat, root, f)).rejects.toThrow(
      "Standalone Chats do not support linked Codex consoles.",
    );
    expect(f.routePairsForConfiguration).not.toHaveBeenCalled();
    expect(f.bridge.request).not.toHaveBeenCalled();
    expect(f.repository.updateChatRuntime).not.toHaveBeenCalled();
  });

  it("supports project folder roots and carries explicit disabled CUA and empty MCP configuration", async () => {
    const f = fixture();
    f.repository.listEffectiveMcpServers.mockResolvedValue([]);
    const launch = await prepareManagedConsoleLaunch(
      { ...context, rootKind: "folder-root", computerUseEnabled: false },
      root,
      f,
    );
    expect(managedSessionContextSchema.parse(launch.session)).toMatchObject({
      contextKind: "project",
      rootKind: "folder-root",
      computerUseEnabled: false,
    });
    expect(launch.mcpServers).toEqual([]);
    expect(f.bridge.request.mock.calls[0]?.[1]).toHaveProperty(
      "mcpServers",
      [],
    );
  });
});
