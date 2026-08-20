import { chatMessageSchema } from "@cantrip/protocol";
import { generateAccountMasterKey } from "@cantrip/crypto";
import type {
  AppLiveServerMessage,
  ChatMessage,
  GitStatus,
} from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clientEncryption } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";
import { createTaskMessageOpaqueContent } from "./task-message-encryption";

import {
  AppLiveQueryBridge,
  appLiveEventQueryKeys,
  appLiveScopeQueryKeys,
} from "./app-live-query";

type AppLiveEvent = Extract<AppLiveServerMessage, { type: "event" }>;

const event = (
  input: Pick<AppLiveEvent, "resource" | "scope"> &
    Partial<Pick<AppLiveEvent, "entityId">>,
): AppLiveEvent => ({
  type: "event",
  cursor: 1,
  action: "updated",
  entityId: input.entityId ?? null,
  revision: null,
  payload: null,
  occurredAt: "2026-08-09T12:00:00.000Z",
  ...input,
});

afterEach(() => clearClientSession());

describe("application live query bridge", () => {
  it("maps typed resources to their scoped query families", () => {
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "worktree-status",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([
      ["worktree-status", "project-one"],
      ["worktree-history", "project-one"],
      ["git-graph-snapshot", "project-one"],
      ["git-graph-metrics", "project-one"],
      ["git-graph-commit-overlay", "project-one"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "project-tab-layout",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([["project-tab-layout", "project-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          entityId: "worktree-one",
          resource: "worktree-status",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([
      ["worktree-status", "project-one", "worktree-one"],
      ["worktree-history", "project-one", "worktree-one"],
      ["git-graph-snapshot", "project-one", "worktree-one"],
      ["git-graph-metrics", "project-one", "worktree-one"],
      ["git-graph-commit-overlay", "project-one", "worktree-one"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "chat-message",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([["messages", "chat-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "chat",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([
      ["chat-sync", "chat-one"],
      ["messages", "chat-one"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "task",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([["task", "chat-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          entityId: "relocation-one",
          resource: "chat-relocation-job",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([
      ["chat-relocation-jobs", "chat-one"],
      ["chat-relocation-job", "relocation-one"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          entityId: "import-one",
          resource: "chat-import-job",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([
      ["chat-import-jobs", "project-one"],
      ["chat-import-job", "import-one"],
      ["external-chat-history", "project-one"],
      ["chats", "project-one"],
      ["project-tab-layout", "project-one"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "workflow-run",
          scope: { kind: "workflow-run", runId: "run-one" },
        }),
      ),
    ).toEqual([["workflow-run", "run-one"]]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["worktrees", "project-one"]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["git-graph-snapshot", "project-one"]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["git-graph-metrics", "project-one"]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "project",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([
      ["projects"],
      ["project-workspaces"],
      ["project-tab-layout", "project-one"],
    ]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["project-tab-layout", "project-one"]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["project-repository-stats", "project-one"]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "terminal",
          scope: { kind: "current-user" },
        }),
      ),
    ).toEqual([["terminals"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          entityId: "workflow-one",
          resource: "workflow-definition",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([["workflow-repository", "project-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "tunnel",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([["tunnels"], ["project-tunnels", "project-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          entityId: "policy-one",
          resource: "policy",
          scope: { kind: "current-user" },
        }),
      ),
    ).toEqual([
      ["policies"],
      ["workspace-policy-assignments"],
      ["project-policy-assignments"],
      ["effective-policies"],
      ["policy", "policy-one"],
    ]);
    expect(appLiveScopeQueryKeys({ kind: "current-user" })).toContainEqual([
      "policies",
    ]);
    expect(appLiveScopeQueryKeys({ kind: "current-user" })).toContainEqual([
      "workspace-policy-assignments",
    ]);
  });

  it("coalesces repeated events before invalidating TanStack Query", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const workerEvent = event({
      resource: "worker",
      scope: { kind: "current-user" },
    });
    bridge.handleEvent(workerEvent);
    bridge.handleEvent({ ...workerEvent, cursor: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workers"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["worker-management"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-sync"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["project-repository-stats"],
    });
    expect(bridge.stats()).toMatchObject({
      coalescedInvalidationCount: 4,
      invalidatedQueryCount: 4,
      invalidationFlushCount: 1,
      receivedEventCount: 2,
    });
  });

  it("invalidates policy state in every connected Settings window", async () => {
    const clients = [new QueryClient(), new QueryClient()];
    const invalidations = clients.map((client) =>
      vi.spyOn(client, "invalidateQueries").mockResolvedValue(),
    );
    const policyEvent = event({
      entityId: "policy-one",
      resource: "policy",
      scope: { kind: "current-user" },
    });

    for (const client of clients) {
      new AppLiveQueryBridge(client).handleEvent(policyEvent);
    }
    await Promise.resolve();
    await Promise.resolve();

    for (const invalidate of invalidations) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["policies"] });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["workspace-policy-assignments"],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["project-policy-assignments"],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["effective-policies"],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["policy", "policy-one"],
      });
    }
  });

  it("reconciles durable messages when a turn boundary follows lost live events", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);

    bridge.handleEvent(
      event({
        entityId: "chat-one",
        resource: "chat",
        scope: { kind: "chat", chatId: "chat-one" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["chat-sync", "chat-one"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["messages", "chat-one"],
    });
  });

  it("upserts persisted message payloads without a follow-up GET", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const first = chatMessageSchema.parse({
      id: "message-one",
      chatId: "chat-one",
      worktreeId: "worktree-one",
      executionLaneId: "lane-one",
      sequence: 1,
      role: "user",
      mode: "default",
      content: [{ type: "text", text: "Start" }],
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    const streamed = chatMessageSchema.parse({
      ...first,
      id: "message-two",
      sequence: 2,
      role: "assistant",
      content: [{ type: "text", text: "Working", phase: "commentary" }],
    });
    queryClient.setQueryData<ChatMessage[]>(["messages", "chat-one"], [first]);

    bridge.handleEvent({
      ...event({
        entityId: streamed.id,
        resource: "chat-message",
        scope: { kind: "chat", chatId: "chat-one" },
      }),
      cursor: 2,
      payload: streamed,
      revision: streamed.sequence,
    });

    expect(
      queryClient.getQueryData<ChatMessage[]>(["messages", "chat-one"]),
    ).toEqual([first, streamed]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("decrypts encrypted Task live messages before updating the cache", async () => {
    const ownerId = "owner-live-task";
    const serverId = "server-live-task";
    setClientSession({
      authMode: "accounts",
      csrfToken: "c".repeat(32),
      expiresAt: "2026-08-20T12:00:00.000Z",
      serverId,
      user: {
        id: ownerId,
        kind: "account",
        displayName: "Task Owner",
        email: "task-owner@example.com",
        role: "owner",
      },
    });
    clientEncryption.setAccountMasterKey({
      accountMasterKey: generateAccountMasterKey(),
      identity: { ownerId, serverId },
      masterKeyRevision: 1,
    });
    const opaque = await createTaskMessageOpaqueContent({
      content: [{ type: "text", text: "SENTINEL live Task message" }],
      idempotencyKey: "task-live:test",
      messageId: "11111111-1111-4111-8111-111111111111",
      mode: "goal",
      role: "assistant",
    });
    const payload = {
      id: opaque.id,
      chatId: "chat-live-task",
      worktreeId: "worktree-one",
      executionLaneId: "lane-one",
      sequence: 1,
      role: opaque.classification.role,
      mode: opaque.classification.mode,
      attachmentIds: opaque.classification.attachmentIds,
      protectedContent: opaque.protectedContent,
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      reasoningEffort: null,
      appliedReasoningEffort: null,
      reasoningAdjusted: false,
      idempotencyKey: opaque.idempotencyKey,
      createdAt: "2026-08-19T12:00:00.000Z",
    };
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    queryClient.setQueryData<ChatMessage[]>(["messages", payload.chatId], []);

    bridge.handleEvent({
      ...event({
        entityId: opaque.id,
        resource: "chat-message",
        scope: { kind: "chat", chatId: payload.chatId },
      }),
      payload,
      revision: payload.sequence,
    });

    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData<ChatMessage[]>(["messages", payload.chatId]),
      ).toMatchObject([
        {
          id: opaque.id,
          content: [{ type: "text", text: "SENTINEL live Task message" }],
        },
      ]),
    );
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("upserts Git status while invalidating revision-derived graph data", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const status = {
      branch: "main",
      head: "a".repeat(40),
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      files: [],
      branches: [],
    };

    bridge.handleEvent({
      ...event({
        entityId: "worktree-one",
        resource: "worktree-status",
        scope: { kind: "project", projectId: "project-one" },
      }),
      payload: status,
    });

    expect(
      queryClient.getQueryData([
        "worktree-status",
        "project-one",
        "worktree-one",
      ]),
    ).toEqual(status);
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["git-graph-snapshot", "project-one", "worktree-one"],
      }),
    );
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: ["worktree-status", "project-one", "worktree-one"],
    });
  });

  it("does not recompute committed graph data for working-tree-only changes", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const queryKey = [
      "worktree-status",
      "project-one",
      "worktree-one",
    ] as const;
    const status = {
      branch: "main",
      head: "a".repeat(40),
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      files: [],
      branches: [],
    };
    queryClient.setQueryData(queryKey, status);
    const bridge = new AppLiveQueryBridge(queryClient);

    bridge.handleEvent({
      ...event({
        entityId: "worktree-one",
        resource: "worktree-status",
        scope: { kind: "project", projectId: "project-one" },
      }),
      payload: {
        ...status,
        files: [
          {
            indexStatus: "?",
            originalPath: null,
            path: "draft.txt",
            staged: false,
            unstaged: true,
            worktreeStatus: "?",
          },
        ],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(queryClient.getQueryData<GitStatus>(queryKey)?.files).toHaveLength(
      1,
    );
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("ignores duplicate and out-of-order payloads for the same message", () => {
    const queryClient = new QueryClient();
    const bridge = new AppLiveQueryBridge(queryClient);
    const message = chatMessageSchema.parse({
      id: "message-one",
      chatId: "chat-one",
      worktreeId: "worktree-one",
      executionLaneId: "lane-one",
      sequence: 1,
      role: "assistant",
      mode: "default",
      content: [{ type: "text", text: "old", phase: "commentary" }],
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    queryClient.setQueryData<ChatMessage[]>(
      ["messages", "chat-one"],
      [message],
    );
    const send = (cursor: number, text: string) =>
      bridge.handleEvent({
        ...event({
          entityId: message.id,
          resource: "chat-message",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
        cursor,
        payload: {
          ...message,
          content: [{ type: "text", text, phase: "commentary" }],
        },
      });

    send(5, "newest");
    send(5, "duplicate");
    send(4, "stale");

    expect(
      queryClient.getQueryData<ChatMessage[]>(["messages", "chat-one"])?.[0]
        ?.content,
    ).toEqual([{ type: "text", text: "newest", phase: "commentary" }]);
  });

  it("accepts a lower cursor after authoritative chat recovery", async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const message = chatMessageSchema.parse({
      id: "message-one",
      chatId: "chat-one",
      worktreeId: "worktree-one",
      executionLaneId: null,
      sequence: 1,
      role: "assistant",
      mode: "default",
      content: [{ type: "text", text: "before restart" }],
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    queryClient.setQueryData<ChatMessage[]>(
      ["messages", "chat-one"],
      [message],
    );
    const send = (cursor: number, text: string) =>
      bridge.handleEvent({
        ...event({
          entityId: message.id,
          resource: "chat-message",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
        cursor,
        payload: {
          ...message,
          content: [{ type: "text", text }],
        },
      });

    send(50, "old epoch");
    await bridge.recoverScopes(
      [{ kind: "chat", chatId: "chat-one" }],
      "server-epoch-changed",
    );
    send(1, "new epoch");

    expect(
      queryClient.getQueryData<ChatMessage[]>(["messages", "chat-one"])?.[0]
        ?.content,
    ).toEqual([{ type: "text", text: "new epoch" }]);
  });

  it("awaits all authoritative scope invalidations during recovery", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    await bridge.recoverScopes(
      [{ kind: "current-user" }, { kind: "chat", chatId: "chat-one" }],
      "server-epoch-changed",
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["projects"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["messages", "chat-one"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["chat-customizations", "chat-one", "inventory"],
    });
  });

  it("applies live customization statuses without a follow-up GET", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = new QueryClient();
      const invalidate = vi
        .spyOn(queryClient, "invalidateQueries")
        .mockResolvedValue();
      const bridge = new AppLiveQueryBridge(queryClient);

      bridge.handleEvent({
        ...event({
          entityId: "mcp-oauth",
          resource: "customization",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
        payload: { server: "docs", status: "succeeded", error: null },
      });
      bridge.handleEvent({
        ...event({
          entityId: "external-import",
          resource: "customization",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
        cursor: 2,
        payload: {
          importId: "import-one",
          status: "completed",
          results: [],
        },
      });

      expect(
        queryClient.getQueryData([
          "chat-customizations",
          "chat-one",
          "mcp-oauth",
          "docs",
        ]),
      ).toEqual({ server: "docs", status: "succeeded", error: null });
      expect(
        queryClient.getQueryData([
          "chat-customizations",
          "chat-one",
          "external-import",
          "import-one",
        ]),
      ).toEqual({ importId: "import-one", status: "completed", results: [] });
      expect(invalidate).not.toHaveBeenCalled();

      bridge.handleEvent({
        ...event({
          resource: "customization",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
        action: "invalidated",
        cursor: 3,
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["chat-customizations", "chat-one", "inventory"],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["skills", "chat-one"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces workflow progress and rejects duplicate durable sequences", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = new QueryClient();
      const invalidate = vi
        .spyOn(queryClient, "invalidateQueries")
        .mockResolvedValue();
      const bridge = new AppLiveQueryBridge(queryClient);
      const runEvent = {
        ...event({
          entityId: "run-one",
          resource: "workflow-node",
          scope: { kind: "workflow-run", runId: "run-one" },
        }),
        revision: 7,
      } satisfies AppLiveEvent;
      const projectEvent = {
        ...runEvent,
        cursor: 2,
        scope: { kind: "project", projectId: "project-one" },
      } satisfies AppLiveEvent;

      bridge.handleEvent(runEvent);
      bridge.handleEvent({ ...runEvent, cursor: 3 });
      bridge.handleEvent({ ...runEvent, cursor: 4, revision: 6 });
      bridge.handleEvent(projectEvent);
      expect(invalidate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(invalidate).toHaveBeenCalledTimes(2);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["workflow-run", "run-one"],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["workflow-runs", "project-one"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a restarted workflow sequence after scope recovery", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = new QueryClient();
      const invalidate = vi
        .spyOn(queryClient, "invalidateQueries")
        .mockResolvedValue();
      const bridge = new AppLiveQueryBridge(queryClient);
      const workflowEvent = (
        cursor: number,
        revision: number,
      ): AppLiveEvent => ({
        ...event({
          entityId: "run-one",
          resource: "workflow-run",
          scope: { kind: "workflow-run", runId: "run-one" },
        }),
        cursor,
        revision,
      });

      bridge.handleEvent(workflowEvent(20, 20));
      await vi.advanceTimersByTimeAsync(100);
      await bridge.recoverScopes(
        [{ kind: "workflow-run", runId: "run-one" }],
        "server-epoch-changed",
      );
      invalidate.mockClear();
      bridge.handleEvent(workflowEvent(1, 1));
      await vi.advanceTimersByTimeAsync(100);

      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["workflow-run", "run-one"],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
