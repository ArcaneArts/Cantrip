import {
  chatMessageSchema,
  workerObservationEnvelopeSchema,
} from "@cantrip/protocol";
import { generateAccountMasterKey } from "@cantrip/crypto";
import type {
  AppLiveServerMessage,
  ChatMessage,
  CodexAuthStatus,
  GitConflictList,
  GitManagedOperationResponse,
  GitStatus,
  WorkspaceRepositoryDiscoverySnapshot,
} from "@cantrip/protocol";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clientEncryption } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";
import { createTaskMessageOpaqueContent } from "./task-message-encryption";
import {
  chatMessageLiveQueryKey,
  chatMessageProvisionalQueryKey,
  type ChatMessageLiveOverlay,
} from "./chat-message-history";

import {
  AppLiveQueryBridge,
  appLiveEventQueryKeys,
  appLiveScopeQueryKeys,
} from "./app-live-query";

type AppLiveEvent = Extract<AppLiveServerMessage, { type: "event" }>;

function liveMessages(queryClient: QueryClient, chatId: string): ChatMessage[] {
  const overlay = queryClient.getQueryData<ChatMessageLiveOverlay>(
    chatMessageLiveQueryKey(chatId),
  );
  return Object.values(overlay?.upserts ?? {}).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

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

const directProjectId = "55555555-5555-4555-8555-555555555555";
const directWorktreeId = "worktree-one";

function directFilesystemObservation(
  continuitySequence: number,
  projectId = directProjectId,
  worktreeId = directWorktreeId,
) {
  return workerObservationEnvelopeSchema.parse({
    protocolVersion: 1,
    subscriptionId: "77777777-7777-4777-8777-777777777777",
    continuitySequence,
    observedAt: "2026-08-09T12:00:00.000Z",
    identity: {
      operationId: "filesystem-one",
      turnId: null,
      messageId: "filesystem-one",
      sequence: continuitySequence,
    },
    payload: {
      topic: "filesystem",
      notification: {
        type: "worktree.filesystem.changed",
        projectId,
        worktreeId,
        sourcePath: "/repo",
        worktreePath: "/repo/worktree",
      },
    },
  });
}

afterEach(() => {
  clearClientSession();
  vi.useRealTimers();
});

describe("application live query bridge", () => {
  it("projects direct chat messages provisionally and removes them when canonical state arrives", async () => {
    const queryClient = new QueryClient();
    const bridge = new AppLiveQueryBridge(queryClient);
    const sourceEvent = {
      operationId: "user-message-1",
      turnId: "turn-1",
      messageId: "agent-message-1",
      sequence: 0,
    };
    const observation = workerObservationEnvelopeSchema.parse({
      protocolVersion: 1,
      subscriptionId: "77777777-7777-4777-8777-777777777777",
      continuitySequence: 0,
      observedAt: "2026-08-09T12:00:00.000Z",
      identity: sourceEvent,
      payload: {
        topic: "chat-progress",
        chatId: "chat-one",
        clientMessageId: "user-message-1",
        executionLaneId: "lane-one",
        contextKind: "project",
        worktreeId: "worktree-one",
        scratchRootId: null,
        event: {
          type: "agent.message",
          message: {
            id: "agent-message-1",
            text: "Working directly",
            phase: "commentary",
            streaming: true,
          },
        },
      },
    });

    await bridge.handleWorkerObservation("worker-one", observation);
    const provisional = queryClient.getQueryData<ChatMessageLiveOverlay>(
      chatMessageProvisionalQueryKey("chat-one"),
    );
    expect(Object.values(provisional?.upserts ?? {})).toHaveLength(1);

    const canonical = chatMessageSchema.parse({
      id: "canonical-message-one",
      chatId: "chat-one",
      contextKind: "project",
      worktreeId: "worktree-one",
      scratchRootId: null,
      executionLaneId: "lane-one",
      sequence: 2,
      role: "assistant",
      mode: "default",
      content: [
        {
          type: "text",
          text: "Working directly",
          phase: "commentary",
          streaming: true,
          sourceEvent,
        },
      ],
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      reasoningEffort: null,
      appliedReasoningEffort: null,
      reasoningAdjusted: false,
      createdAt: "2026-08-09T12:00:01.000Z",
    });
    bridge.handleEvent({
      ...event({
        resource: "chat-message",
        scope: { kind: "chat", chatId: "chat-one" },
        entityId: canonical.id,
      }),
      revision: canonical.sequence,
      payload: canonical,
    });

    expect(
      Object.values(
        queryClient.getQueryData<ChatMessageLiveOverlay>(
          chatMessageProvisionalQueryKey("chat-one"),
        )?.upserts ?? {},
      ),
    ).toEqual([]);
    expect(liveMessages(queryClient, "chat-one")).toEqual([canonical]);

    await bridge.handleWorkerObservation(
      "worker-one",
      workerObservationEnvelopeSchema.parse({
        ...observation,
        continuitySequence: 1,
        identity: {
          operationId: "user-message-1",
          turnId: "turn-1",
          messageId: "activity-1",
          sequence: 1,
        },
        payload: {
          ...observation.payload,
          event: {
            type: "agent.activity",
            activity: {
              type: "reasoning",
              id: "activity-1",
              status: "running",
              summary: ["Still working"],
              correlation: {
                sourceMethod: "item/started",
                diagnosticId: null,
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "activity-1",
              },
            },
          },
        },
      }),
    );
    const finalMessage = chatMessageSchema.parse({
      ...canonical,
      id: "canonical-final-one",
      sequence: 3,
      content: [
        {
          type: "text",
          text: "Done",
          phase: "final_answer",
          sourceEvent: {
            operationId: "user-message-1",
            turnId: "turn-1",
            messageId: "final-1",
            sequence: 2,
          },
        },
      ],
    });
    bridge.handleEvent({
      ...event({
        resource: "chat-message",
        scope: { kind: "chat", chatId: "chat-one" },
        entityId: finalMessage.id,
      }),
      cursor: 2,
      revision: finalMessage.sequence,
      payload: finalMessage,
    });
    expect(
      Object.values(
        queryClient.getQueryData<ChatMessageLiveOverlay>(
          chatMessageProvisionalQueryKey("chat-one"),
        )?.upserts ?? {},
      ),
    ).toEqual([]);
  });

  it("does not let delayed canonical inference progress regress a newer direct observation", async () => {
    const queryClient = new QueryClient();
    const bridge = new AppLiveQueryBridge(queryClient);
    const progress = {
      kind: "progress" as const,
      requestId: "request-one",
      cycle: 1,
      sequence: 4,
      phase: "generating" as const,
      fractionComplete: 0.5,
      completedTokens: 50,
      totalTokens: 100,
      precision: "exact" as const,
      source: "provider-stream" as const,
      startedAt: "2026-08-09T12:00:00.000Z",
      observedAt: "2026-08-09T12:00:04.000Z",
    };
    await bridge.handleWorkerObservation(
      "worker-one",
      workerObservationEnvelopeSchema.parse({
        protocolVersion: 1,
        subscriptionId: "77777777-7777-4777-8777-777777777777",
        continuitySequence: 0,
        observedAt: progress.observedAt,
        identity: {
          operationId: progress.requestId,
          turnId: null,
          messageId: progress.requestId,
          sequence: progress.sequence,
        },
        payload: {
          topic: "chat-progress",
          chatId: "chat-one",
          clientMessageId: progress.requestId,
          executionLaneId: "lane-one",
          contextKind: "project",
          worktreeId: "worktree-one",
          scratchRootId: null,
          event: { type: "agent.inference-progress", progress },
        },
      }),
    );
    bridge.handleEvent({
      ...event({
        resource: "inference-progress",
        scope: { kind: "chat", chatId: "chat-one" },
        entityId: progress.requestId,
      }),
      revision: 3,
      payload: { ...progress, sequence: 3 },
    });
    expect(
      queryClient.getQueryData(["inference-progress", "chat-one"]),
    ).toEqual(progress);

    bridge.handleEvent({
      ...event({
        resource: "inference-progress",
        scope: { kind: "chat", chatId: "chat-one" },
        entityId: progress.requestId,
      }),
      cursor: 2,
      revision: 4,
      payload: progress,
    });
    await bridge.recoverWorkerObservations("worker-one");
    expect(
      queryClient.getQueryData(["inference-progress", "chat-one"]),
    ).toEqual(progress);
  });

  it("coalesces 1,000 exact filesystem hints into one bounded refetch", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const affectedQueryFn = vi.fn(async () => ({ entries: [] }));
    const unrelatedQueryFn = vi.fn(async () => ({ theme: "dark" }));
    const affectedQueryKey = [
      "explorer-directory",
      directProjectId,
      directWorktreeId,
      "explorer-one",
      "src",
      "binding-one",
    ] as const;
    const unrelatedQueryKey = ["settings"] as const;
    await queryClient.fetchQuery({
      queryFn: affectedQueryFn,
      queryKey: affectedQueryKey,
      staleTime: Number.POSITIVE_INFINITY,
    });
    await queryClient.fetchQuery({
      queryFn: unrelatedQueryFn,
      queryKey: unrelatedQueryKey,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const affectedObserver = new QueryObserver(queryClient, {
      queryFn: affectedQueryFn,
      queryKey: affectedQueryKey,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unrelatedObserver = new QueryObserver(queryClient, {
      queryFn: unrelatedQueryFn,
      queryKey: unrelatedQueryKey,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribeAffected = affectedObserver.subscribe(() => undefined);
    const unsubscribeUnrelated = unrelatedObserver.subscribe(() => undefined);
    affectedQueryFn.mockClear();
    unrelatedQueryFn.mockClear();
    const bridge = new AppLiveQueryBridge(queryClient);
    await Promise.all(
      Array.from({ length: 1_000 }, (_, sequence) =>
        bridge.handleWorkerObservation(
          "worker-one",
          directFilesystemObservation(sequence),
        ),
      ),
    );
    await vi.waitFor(() => expect(affectedQueryFn).toHaveBeenCalledOnce());

    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["explorer-directory", directProjectId, directWorktreeId],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [
        "explorer-directory-commits",
        directProjectId,
        directWorktreeId,
      ],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["explorer-file"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["project-repository-stats", directProjectId],
    });
    expect(unrelatedQueryFn).not.toHaveBeenCalled();
    expect(bridge.stats()).toMatchObject({
      coalescedInvalidationCount: 3_996,
      invalidatedQueryCount: 4,
      invalidationFlushCount: 1,
    });
    unsubscribeAffected();
    unsubscribeUnrelated();
  });

  it("reconciles only a promoted worker's affected query families", async () => {
    const otherProjectId = "66666666-6666-4666-8666-666666666666";
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    await bridge.handleWorkerObservation(
      "worker-one",
      directFilesystemObservation(0),
    );
    await bridge.handleWorkerObservation(
      "worker-two",
      directFilesystemObservation(0, otherProjectId, "worktree-two"),
    );
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(7));
    invalidate.mockClear();

    await bridge.recoverWorkerObservations("worker-one", "affected");

    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate).not.toHaveBeenCalledWith();
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["settings"] });
    expect(
      invalidate.mock.calls.some(([input]) =>
        input?.queryKey?.includes(otherProjectId),
      ),
    ).toBe(false);
    invalidate.mockClear();
    await bridge.recoverWorkerObservations("worker-one", "affected");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reserves app-wide recovery for unbounded continuity loss", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    await bridge.handleWorkerObservation(
      "worker-one",
      directFilesystemObservation(0),
    );

    await bridge.recoverWorkerObservations("worker-one", "unbounded");

    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("removes provisional chat state with an exact scoped reconciliation", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    await bridge.handleWorkerObservation(
      "worker-one",
      workerObservationEnvelopeSchema.parse({
        protocolVersion: 1,
        subscriptionId: "77777777-7777-4777-8777-777777777777",
        continuitySequence: 0,
        observedAt: "2026-08-09T12:00:00.000Z",
        identity: {
          operationId: "user-message-route",
          turnId: "turn-route",
          messageId: "agent-message-route",
          sequence: 0,
        },
        payload: {
          topic: "chat-progress",
          chatId: "chat-route",
          clientMessageId: "user-message-route",
          executionLaneId: "lane-route",
          contextKind: "project",
          worktreeId: directWorktreeId,
          scratchRootId: null,
          event: {
            type: "agent.message",
            message: {
              id: "agent-message-route",
              text: "Moving routes",
              phase: "commentary",
              streaming: true,
            },
          },
        },
      }),
    );
    expect(
      Object.values(
        queryClient.getQueryData<ChatMessageLiveOverlay>(
          chatMessageProvisionalQueryKey("chat-route"),
        )?.upserts ?? {},
      ),
    ).toHaveLength(1);

    await bridge.recoverWorkerObservations("worker-one", "affected");

    expect(
      Object.values(
        queryClient.getQueryData<ChatMessageLiveOverlay>(
          chatMessageProvisionalQueryKey("chat-route"),
        )?.upserts ?? {},
      ),
    ).toEqual([]);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["messages", "chat-route", "pages"],
    });
  });

  it("maps typed resources to their scoped query families", () => {
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "account-session",
          scope: { kind: "current-user" },
        }),
      ),
    ).toEqual([["account-sessions"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "account-resource-usage",
          scope: { kind: "current-user" },
        }),
      ),
    ).toEqual([["account-resource-usage"], ["account-resource-usage-history"]]);
    expect(
      appLiveEventQueryKeys(
        event({ resource: "settings", scope: { kind: "current-user" } }),
      ),
    ).toEqual([
      ["settings"],
      ["task-workers"],
      ["code-settings-worker-status"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "project-automation",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([["project-automations", "project-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "project-token-usage",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([["project-token-usage", "project-one"]]);
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
          entityId: "worktree-one",
          resource: "codegraph-status",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([["codegraph", "project-one", "worktree-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "chat-message",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([
      ["messages", "chat-one"],
      ["message-history", "chat-one"],
      ["project-task-workload"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "chat-files",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([["standalone-chat-files", "chat-one"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "chat",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([
      ["chats", "project-one"],
      ["run-configurations", "project-one"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "chat",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([
      ["standalone-chats"],
      ["messages", "chat-one"],
      ["chat-runtime-selection", "chat-one"],
      ["task-dashboard", "chat-one"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "chat",
          scope: { kind: "current-user" },
        }),
      ),
    ).toEqual([["chats"], ["standalone-chats"], ["archived-standalone-chats"]]);
    expect(
      appLiveEventQueryKeys(
        event({
          entityId: "replica-job-one",
          resource: "project-replica-job",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([
      ["project-replica-jobs", "project-one"],
      ["project-replica-job", "replica-job-one"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "project-github-conversion-job",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toContainEqual(["project-github-conversion", "project-one"]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "task",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([
      ["task", "chat-one"],
      ["task-dashboard", "chat-one"],
      ["project-task-workload"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "chat-goal",
          scope: { kind: "chat", chatId: "chat-one" },
        }),
      ),
    ).toEqual([
      ["goal", "chat-one"],
      ["task-dashboard", "chat-one"],
      ["project-task-workload"],
    ]);
    expect(
      appLiveEventQueryKeys(
        event({
          resource: "task",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([
      ["project-task-workload", "project-one"],
      ["project-task-pause", "project-one"],
    ]);
    expect(
      appLiveScopeQueryKeys({ kind: "chat", chatId: "chat-one" }),
    ).toContainEqual(["task-dashboard", "chat-one"]);
    expect(
      appLiveScopeQueryKeys({ kind: "chat", chatId: "chat-one" }),
    ).toContainEqual(["chat-sync", "chat-one"]);
    expect(
      appLiveScopeQueryKeys({ kind: "chat", chatId: "chat-one" }),
    ).toContainEqual(["standalone-chats"]);
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
    ).toEqual([
      ["workflow-run", "run-one"],
      ["workflow-interactions", "run-one"],
    ]);
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
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["codegraph", "project-one"]);
    expect(
      appLiveEventQueryKeys(
        event({
          entityId: "worktree-one",
          resource: "explorer-filesystem",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([
      ["explorer-directory", "project-one", "worktree-one"],
      ["explorer-directory-commits", "project-one", "worktree-one"],
      ["project-repository-stats", "project-one"],
    ]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["explorer-directory", "project-one"]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["explorer-directory-commits", "project-one"]);
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
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["run-configurations", "project-one"]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["run-configuration-secrets", "project-one"]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["project-replica-jobs", "project-one"]);
    expect(
      appLiveEventQueryKeys(
        event({
          entityId: "workspace-one",
          resource: "workspace-repository-discovery-job",
          scope: { kind: "current-user" },
        }),
      ),
    ).toEqual([["workspace-repository-discovery", "workspace-one"]]);
    expect(appLiveScopeQueryKeys({ kind: "current-user" })).toContainEqual([
      "workspace-repository-discovery",
    ]);
    expect(
      appLiveScopeQueryKeys({ kind: "project", projectId: "project-one" }),
    ).toContainEqual(["project-github-conversion", "project-one"]);
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
          resource: "run",
          scope: { kind: "project", projectId: "project-one" },
        }),
      ),
    ).toEqual([
      ["run-configuration-runtimes", "project-one"],
      ["terminals", "project-one"],
    ]);

    expect(
      appLiveEventQueryKeys(
        event({
          resource: "run-configuration",
          scope: { kind: "project", projectId: "project-one" },
          entityId: "configuration-one",
        }),
      ),
    ).toEqual([
      ["run-configurations", "project-one"],
      ["run-configuration-secrets", "project-one"],
      ["run-configuration", "project-one", "configuration-one"],
    ]);
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
    expect(appLiveScopeQueryKeys({ kind: "current-user" })).toContainEqual([
      "code-settings-worker-status",
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
    expect(invalidate).toHaveBeenCalledTimes(5);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workers"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["worker-management"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["worker-enrollment-status"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["desktop-worker-enrollment-status"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-sync"] });
    expect(bridge.stats()).toMatchObject({
      coalescedInvalidationCount: 5,
      invalidatedQueryCount: 5,
      invalidationFlushCount: 1,
      receivedEventCount: 2,
    });
  });

  it("refreshes worker-backed project data for availability changes", () => {
    expect(
      appLiveEventQueryKeys(
        event({
          entityId: "worker-one",
          resource: "worker-availability",
          scope: { kind: "current-user" },
        }),
      ),
    ).toEqual([
      ["workers"],
      ["worker-management"],
      ["worker-enrollment-status"],
      ["desktop-worker-enrollment-status"],
      ["chat-sync"],
      ["project-repository-stats"],
      ["run-configurations"],
    ]);
  });

  it("coalesces repository mutation statistics invalidation", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const filesystemEvent = event({
      entityId: "worktree-one",
      resource: "explorer-filesystem",
      scope: { kind: "project", projectId: "project-one" },
    });

    bridge.handleEvent(filesystemEvent);
    bridge.handleEvent({ ...filesystemEvent, cursor: 2 });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      invalidate.mock.calls.filter(
        ([input]) =>
          JSON.stringify(input?.queryKey) ===
          JSON.stringify(["project-repository-stats", "project-one"]),
      ),
    ).toHaveLength(1);
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

  it("does not feed a live turn boundary back into chat sync", async () => {
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

    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: ["chat-sync", "chat-one"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["messages", "chat-one"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["chat-runtime-selection", "chat-one"],
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

    expect(liveMessages(queryClient, "chat-one")).toEqual([streamed]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("applies and clears ephemeral inference progress without a GET", () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const progress = {
      kind: "progress" as const,
      requestId: "message-one",
      cycle: 1,
      sequence: 2,
      phase: "prefill" as const,
      fractionComplete: 10_240 / 46_492,
      completedTokens: 10_240,
      totalTokens: 46_492,
      precision: "estimated" as const,
      source: "provider-observer" as const,
      startedAt: "2026-08-24T11:59:00.000Z",
      observedAt: "2026-08-24T12:00:00.000Z",
    };
    bridge.handleEvent({
      ...event({
        entityId: progress.requestId,
        resource: "inference-progress",
        scope: { kind: "chat", chatId: "chat-one" },
      }),
      cursor: 10,
      payload: progress,
      revision: progress.sequence,
    });

    expect(
      queryClient.getQueryData(["inference-progress", "chat-one"]),
    ).toEqual(progress);
    expect(
      queryClient.getQueryData(["inference-progress-history", "chat-one"]),
    ).toEqual([{ completedAt: null, progress }]);
    expect(invalidate).not.toHaveBeenCalled();

    bridge.handleEvent({
      ...event({
        entityId: progress.requestId,
        resource: "inference-progress",
        scope: { kind: "chat", chatId: "chat-one" },
      }),
      action: "deleted",
      cursor: 11,
      payload: null,
      revision: 3,
    });
    expect(
      queryClient.getQueryData(["inference-progress", "chat-one"]),
    ).toBeNull();
    expect(
      queryClient.getQueryData(["inference-progress-history", "chat-one"]),
    ).toEqual([{ completedAt: "2026-08-09T12:00:00.000Z", progress }]);
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
      expect(liveMessages(queryClient, payload.chatId)).toMatchObject([
        {
          id: opaque.id,
          content: [{ type: "text", text: "SENTINEL live Task message" }],
        },
      ]),
    );
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps a newer protected direct revision until the matching canonical ciphertext arrives", async () => {
    const ownerId = "owner-direct-task";
    const serverId = "server-direct-task";
    setClientSession({
      authMode: "accounts",
      csrfToken: "c".repeat(32),
      expiresAt: "2026-08-20T12:00:00.000Z",
      serverId,
      user: {
        id: ownerId,
        kind: "account",
        displayName: "Direct Task Owner",
        email: "direct-task@example.com",
        role: "owner",
      },
    });
    clientEncryption.setAccountMasterKey({
      accountMasterKey: generateAccountMasterKey(),
      identity: { ownerId, serverId },
      masterKeyRevision: 1,
    });
    const messageId = "22222222-2222-4222-8222-222222222222";
    const oldOpaque = await createTaskMessageOpaqueContent({
      content: [
        {
          type: "text",
          text: "older protected progress",
          phase: "commentary",
          streaming: true,
        },
      ],
      idempotencyKey: "task-direct:test",
      messageId,
      mode: "goal",
      role: "assistant",
    });
    const directOpaque = await createTaskMessageOpaqueContent({
      content: [
        {
          type: "text",
          text: "newer protected progress",
          phase: "commentary",
          streaming: true,
        },
      ],
      idempotencyKey: "task-direct:test",
      messageId,
      mode: "goal",
      role: "assistant",
    });
    const summary = (opaque: typeof directOpaque, sequence: number) => ({
      id: opaque.id,
      chatId: "chat-direct-task",
      worktreeId: "worktree-one",
      executionLaneId: "lane-one",
      sequence,
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
    });
    const queryClient = new QueryClient();
    const bridge = new AppLiveQueryBridge(queryClient);
    await bridge.handleWorkerObservation(
      "worker-one",
      workerObservationEnvelopeSchema.parse({
        protocolVersion: 1,
        subscriptionId: "77777777-7777-4777-8777-777777777777",
        continuitySequence: 0,
        observedAt: "2026-08-19T12:00:01.000Z",
        identity: {
          operationId: "user-message-one",
          turnId: "turn-one",
          messageId,
          sequence: 0,
        },
        payload: {
          topic: "chat-progress",
          chatId: "chat-direct-task",
          clientMessageId: "user-message-one",
          executionLaneId: "lane-one",
          contextKind: "project",
          worktreeId: "worktree-one",
          scratchRootId: null,
          event: {
            type: "agent.protected-task-message",
            message: directOpaque,
            telemetry: {
              kind: "message",
              phase: "commentary",
              streaming: true,
              turnId: "turn-one",
            },
          },
        },
      }),
    );

    bridge.handleEvent({
      ...event({
        entityId: messageId,
        resource: "chat-message",
        scope: { kind: "chat", chatId: "chat-direct-task" },
      }),
      payload: summary(oldOpaque, 1),
      revision: 1,
    });
    await vi.waitFor(() =>
      expect(
        Object.values(
          queryClient.getQueryData<ChatMessageLiveOverlay>(
            chatMessageProvisionalQueryKey("chat-direct-task"),
          )?.upserts ?? {},
        ),
      ).toHaveLength(1),
    );

    bridge.handleEvent({
      ...event({
        entityId: messageId,
        resource: "chat-message",
        scope: { kind: "chat", chatId: "chat-direct-task" },
      }),
      cursor: 2,
      payload: summary(directOpaque, 1),
      revision: 1,
    });
    await vi.waitFor(() =>
      expect(
        Object.values(
          queryClient.getQueryData<ChatMessageLiveOverlay>(
            chatMessageProvisionalQueryKey("chat-direct-task"),
          )?.upserts ?? {},
        ),
      ).toEqual([]),
    );
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

  it("applies workspace repository discovery progress without polling", () => {
    const workspaceId = "workspace-one";
    const queryKey = ["workspace-repository-discovery", workspaceId] as const;
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const snapshot: WorkspaceRepositoryDiscoverySnapshot = {
      job: {
        id: "00000000-0000-4000-8000-000000000001",
        workspaceId,
        workerId: "worker-one",
        state: "running",
        stateRevision: 2,
        attempt: 1,
        depth: 3,
        truncated: false,
        counts: null,
        error: null,
        createdAt: "2026-08-09T12:00:00.000Z",
        updatedAt: "2026-08-09T12:00:01.000Z",
        startedAt: "2026-08-09T12:00:01.000Z",
        completedAt: null,
      },
      candidates: [],
      progress: null,
    };
    queryClient.setQueryData(queryKey, snapshot);
    const bridge = new AppLiveQueryBridge(queryClient);
    const progress = {
      counts: {
        candidates: 2,
        collapsedRepositories: 1,
        rejectedRepositories: 3,
        scannedDirectories: 8,
        scannedEntries: 21,
        skippedSymlinks: 1,
        unreadableDirectories: 2,
      },
      truncated: false,
    };

    bridge.handleEvent({
      ...event({
        entityId: workspaceId,
        resource: "workspace-repository-discovery-job",
        scope: { kind: "current-user" },
      }),
      action: "status",
      payload: { progress },
    });

    expect(
      queryClient.getQueryData<WorkspaceRepositoryDiscoverySnapshot>(queryKey)
        ?.progress,
    ).toEqual(progress);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("applies ordered CodeGraph status payloads without a follow-up GET", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const worktreeId = "worktree-one";
    const queryKey = ["codegraph", projectId, worktreeId] as const;
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const status = {
      projectId,
      worktreeId,
      state: "indexing" as const,
      lastIndexedAt: null,
      lastSuccessfulSyncAt: null,
      fileCount: 1,
      nodeCount: 2,
      edgeCount: 3,
      pendingChanges: 4,
      statusMessage: "Indexing",
      job: null,
    };
    const send = (revision: number, pendingChanges: number) =>
      bridge.handleEvent({
        ...event({
          entityId: worktreeId,
          resource: "codegraph-status",
          scope: { kind: "project", projectId },
        }),
        revision,
        payload: { ...status, pendingChanges },
      });

    send(5, 2);
    send(5, 9);
    send(4, 8);

    expect(queryClient.getQueryData(queryKey)).toEqual({
      ...status,
      pendingChanges: 2,
    });
    expect(invalidate).not.toHaveBeenCalled();

    await bridge.recoverScopes(
      [{ kind: "project", projectId }],
      "server-epoch-changed",
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["codegraph", projectId],
    });
    send(1, 1);
    expect(queryClient.getQueryData(queryKey)).toEqual({
      ...status,
      pendingChanges: 1,
    });
  });

  it("applies ordered Git operation and conflict payloads without polling", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const worktreeId = "00000000-0000-4000-8000-000000000002";
    const operationId = "00000000-0000-4000-8000-000000000003";
    const head = "a".repeat(40);
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const operation = {
      id: operationId,
      projectId,
      worktreeId,
      workerId: "worker-one",
      type: "rebase" as const,
      state: "conflicted" as const,
      originalHead: head,
      currentHead: head,
      sourceRef: "origin/main",
      sourceRevision: "b".repeat(40),
      targetRef: "refs/heads/feature",
      targetRevision: head,
      pendingCommits: [head],
      currentStep: 1,
      totalSteps: 1,
      conflictedPaths: ["src/app.ts"],
      output: "CONFLICT",
      error: null,
      checkpointRef: null,
      pausedAction: null,
      createdAt: "2026-08-21T12:00:00.000Z",
      updatedAt: "2026-08-21T12:01:00.000Z",
      completedAt: null,
    };
    const operationEvent = (
      revision: number,
      state: "conflicted" | "completed",
    ) => ({
      ...event({
        entityId: operationId,
        resource: "git-operation" as const,
        scope: { kind: "project" as const, projectId },
      }),
      cursor: revision,
      revision,
      payload: {
        operation: {
          ...operation,
          state,
          pendingCommits: state === "completed" ? [] : operation.pendingCommits,
          conflictedPaths:
            state === "completed" ? [] : operation.conflictedPaths,
          completedAt:
            state === "completed" ? "2026-08-21T12:02:00.000Z" : null,
        },
      },
    });
    const conflictPayload = {
      files: [
        {
          path: "src/app.ts",
          code: "UU",
          kind: "both-modified" as const,
          baseAvailable: true,
          oursAvailable: true,
          theirsAvailable: true,
        },
      ],
      truncated: false,
    };

    bridge.handleEvent(operationEvent(5, "conflicted"));
    bridge.handleEvent(operationEvent(4, "completed"));
    bridge.handleEvent({
      ...event({
        entityId: worktreeId,
        resource: "git-conflict",
        scope: { kind: "project", projectId },
      }),
      cursor: 6,
      revision: 6,
      payload: conflictPayload,
    });

    expect(
      queryClient.getQueryData<GitManagedOperationResponse>([
        "git-operation",
        projectId,
        worktreeId,
      ])?.operation?.state,
    ).toBe("conflicted");
    expect(
      queryClient.getQueryData<GitConflictList>([
        "git-conflicts",
        projectId,
        worktreeId,
      ]),
    ).toEqual(conflictPayload);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["git-conflict", projectId, worktreeId],
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: ["git-conflicts", projectId, worktreeId],
    });

    await bridge.recoverScopes(
      [{ kind: "project", projectId }],
      "server-epoch-changed",
    );
    bridge.handleEvent(operationEvent(1, "completed"));
    expect(
      queryClient.getQueryData<GitManagedOperationResponse>([
        "git-operation",
        projectId,
        worktreeId,
      ])?.operation?.state,
    ).toBe("completed");
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["git-operation", projectId],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["project-repository-stats", projectId],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["git-conflicts", projectId],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["git-conflict", projectId],
    });
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

    expect(liveMessages(queryClient, "chat-one")[0]?.content).toEqual([
      { type: "text", text: "newest", phase: "commentary" },
    ]);
  });

  it("applies safe provider auth lifecycle state and rejects stale revisions", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const bridge = new AppLiveQueryBridge(queryClient);
    const authEvent = (
      revision: number,
      state: "authenticated" | "expired" | "pending" | "signed-out",
    ): AppLiveEvent => ({
      ...event({
        entityId: "account-one",
        resource: "provider-auth",
        scope: { kind: "current-user" },
      }),
      action: "status",
      revision,
      payload: {
        providerId: "provider-one",
        providerAccountId: "account-one",
        providerKind: "chatgpt",
        workerId: "worker-one",
        revision,
        observedAt: "2026-08-21T12:00:00.000Z",
        expiresAt: "2026-08-21T12:15:00.000Z",
        status: {
          state,
          authMode: state === "authenticated" ? "chatgpt" : null,
          email: state === "authenticated" ? "person@example.com" : null,
          planType: state === "authenticated" ? "plus" : null,
          weeklyUsage: null,
          failureCode: state === "expired" ? "authorization-expired" : null,
        },
      },
    });
    const queryKey = ["codex-auth", "provider-one", "account-one"] as const;

    bridge.handleEvent(authEvent(1, "pending"));
    expect(queryClient.getQueryData<CodexAuthStatus>(queryKey)).toMatchObject({
      authenticated: false,
      loginPending: true,
    });
    bridge.handleEvent(authEvent(2, "authenticated"));
    bridge.handleEvent(authEvent(1, "pending"));
    expect(queryClient.getQueryData<CodexAuthStatus>(queryKey)).toMatchObject({
      authenticated: true,
      authMode: "chatgpt",
      email: "person@example.com",
      loginPending: false,
    });
    expect(invalidate).not.toHaveBeenCalled();

    bridge.handleEvent(authEvent(3, "expired"));
    expect(queryClient.getQueryData<CodexAuthStatus>(queryKey)).toMatchObject({
      authenticated: false,
      loginPending: false,
      loginError: "The provider sign-in code expired.",
    });

    await bridge.recoverScopes(
      [{ kind: "current-user" }],
      "server-epoch-changed",
    );
    bridge.handleEvent(authEvent(1, "signed-out"));
    expect(queryClient.getQueryData<CodexAuthStatus>(queryKey)).toMatchObject({
      authenticated: false,
      loginPending: false,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["codex-auth"] });
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

    expect(liveMessages(queryClient, "chat-one")[0]?.content).toEqual([
      { type: "text", text: "new epoch" },
    ]);
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
      queryKey: ["worker-management"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["account-sessions"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["worker-enrollment-status"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["messages", "chat-one"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["task-dashboard", "chat-one"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["chat-customizations", "chat-one", "inventory"],
    });
  });

  it("treats customization live events as invalidations, not plaintext status", async () => {
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
      await vi.advanceTimersByTimeAsync(100);

      expect(
        queryClient.getQueryData([
          "chat-customizations",
          "chat-one",
          "mcp-oauth",
          "docs",
        ]),
      ).toBeUndefined();

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

      expect(invalidate).toHaveBeenCalledTimes(3);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["workflow-run", "run-one"],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["workflow-interactions", "run-one"],
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
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["workflow-interactions", "run-one"],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
