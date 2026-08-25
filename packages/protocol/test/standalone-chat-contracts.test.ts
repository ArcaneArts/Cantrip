import {
  appDestinationUpdateSchema,
  chatExecutionRootSchema,
  contextualChatSummarySchema,
  contextualChatExecutionLaneSummarySchema,
  serverBootstrapSchema,
  standaloneChatFileOperationCommandSchema,
  userSettingsSchema,
} from "../src/index.js";
import {
  standaloneChatFileOperationRequestContentSchema,
  standaloneChatFileWireRequestSchema,
  surfaceStreamContextSchema,
} from "../src/surface-stream.js";
import { describe, expect, it } from "vitest";

const commonChat = {
  id: "chat-1",
  position: 0,
  status: "idle",
  activeWorkerId: "worker-1",
  placementRevision: 1,
  modelId: null,
  reasoningEffort: null,
  permissionProfileId: null,
  hasUnreadCompletion: false,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  title: "Chat",
} as const;

describe("standalone Chat contracts", () => {
  it("parses project and standalone Chats as a discriminated union", () => {
    const project = contextualChatSummarySchema.parse({
      ...commonChat,
      projectId: "project-1",
      activeWorktreeId: "worktree-1",
      worktreeMode: "agent-managed",
      experience: "agent",
      planMode: "default",
      hasPendingPlanQuestion: false,
    });
    expect(project).toMatchObject({
      contextKind: "project",
      activeScratchRootId: null,
    });

    const standalone = contextualChatSummarySchema.parse({
      ...commonChat,
      contextKind: "standalone",
      projectId: null,
      activeWorktreeId: null,
      activeScratchRootId: "scratch-1",
      worktreeMode: null,
      experience: "agent",
      planMode: "default",
      hasPendingPlanQuestion: false,
    });
    expect(standalone.contextKind).toBe("standalone");
    if (standalone.contextKind === "standalone") {
      expect(standalone.activeScratchRootId).toBe("scratch-1");
      expect(standalone.projectId).toBeNull();
    }

    expect(
      contextualChatSummarySchema.safeParse({
        ...standalone,
        experience: "task",
      }).success,
    ).toBe(false);
  });

  it("requires exactly one tagged execution root", () => {
    expect(
      chatExecutionRootSchema.parse({
        contextKind: "project",
        worktreeId: "worktree-1",
        scratchRootId: null,
      }),
    ).toEqual({
      contextKind: "project",
      worktreeId: "worktree-1",
      scratchRootId: null,
    });
    expect(
      chatExecutionRootSchema.safeParse({
        contextKind: "standalone",
        worktreeId: "worktree-1",
        scratchRootId: "scratch-1",
      }).success,
    ).toBe(false);

    const lane = contextualChatExecutionLaneSummarySchema.parse({
      id: "lane-1",
      chatId: "chat-1",
      contextKind: "standalone",
      worktreeId: null,
      scratchRootId: "scratch-1",
      workerId: "worker-1",
      acquiringActor: "user",
      exclusive: true,
      purpose: "Standalone Chat",
      state: "suspended",
      baseRevision: null,
      startingHead: null,
      runtimeSessionId: "runtime-1",
      codexThreadId: null,
      transitionKind: null,
      createdAt: "2026-08-25T00:00:00.000Z",
      activatedAt: null,
      releasedAt: null,
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    expect(lane.contextKind).toBe("standalone");
  });

  it("defaults Chat settings safely and requires revisioned navigation", () => {
    const settings = userSettingsSchema.parse({
      theme: "system",
      highContrast: false,
      proMode: false,
      proModeOpacity: 80,
      sidebarWidth: 288,
      desktopFrameRate: 30,
      desktopStreamQuality: "adaptive",
      defaultModelId: null,
    });
    expect(settings).toMatchObject({
      defaultChatModelId: null,
      defaultChatReasoningEffort: null,
      defaultChatPermissionProfileId: ":workspace",
      lastAppMode: null,
      lastIdeProjectId: null,
      lastIdeWorkspaceId: null,
      lastStandaloneChatId: null,
      destinationRevision: 1,
    });

    expect(
      appDestinationUpdateSchema.safeParse({ expectedRevision: 1 }).success,
    ).toBe(false);
    expect(
      appDestinationUpdateSchema.parse({
        expectedRevision: 1,
        lastAppMode: "chat",
      }),
    ).toEqual({ expectedRevision: 1, lastAppMode: "chat" });
  });

  it("defaults older bootstrap payloads to unavailable standalone Chat", () => {
    const result = serverBootstrapSchema.shape.capabilities.parse({
      accounts: false,
      passwordProtection: false,
      linkCodes: false,
      multipleWorkers: false,
      workerSwitching: false,
      gitSync: false,
      worktrees: true,
      remoteSurfaces: {
        enabled: true,
        transports: ["websocket"],
        relayOnly: true,
      },
      code: {
        enabled: true,
        transport: "web-proxy",
        isolatedOrigin: true,
      },
    });
    expect(result.standaloneChat).toEqual({
      available: false,
      protocolVersion: 1,
      reason: "Standalone Chat is not enabled by this server.",
    });
  });

  it("bounds protected Chat file operations and declares their capability intent", () => {
    expect(
      standaloneChatFileOperationRequestContentSchema.parse({
        type: "chat-files.entry.delete",
        path: "results/output.json",
      }),
    ).toEqual({
      type: "chat-files.entry.delete",
      path: "results/output.json",
      recursive: false,
    });
    expect(
      standaloneChatFileOperationRequestContentSchema.safeParse({
        type: "chat-files.download.prepare",
        kind: "all",
        path: "results",
      }).success,
    ).toBe(false);
    expect(
      standaloneChatFileOperationRequestContentSchema.safeParse({
        type: "chat-files.media.read",
        path: "image.png",
        offset: 0,
        limit: 256 * 1_024 + 1,
      }).success,
    ).toBe(false);
    expect(
      surfaceStreamContextSchema.parse({
        serverId: "server-1",
        surfaceKind: "chat-files",
        surfaceId: "00000000-0000-4000-8000-000000000001",
        operationId: "operation-1",
        direction: "request",
        sequence: 0,
      }).surfaceKind,
    ).toBe("chat-files");

    const protectedRequest = {
      formatVersion: 1 as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    const wire = standaloneChatFileWireRequestSchema.parse({
      intent: "write",
      operationId: "operation-1",
      sequence: 0,
      protectedRequest,
    });
    expect(wire.intent).toBe("write");
    expect(
      standaloneChatFileOperationCommandSchema.parse({
        type: "chat.scratch.files.operation",
        rootId: "00000000-0000-4000-8000-000000000001",
        chatId: "00000000-0000-4000-8000-000000000002",
        serverId: "server-1",
        root: "ctrr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ...wire,
      }).type,
    ).toBe("chat.scratch.files.operation");
  });
});
