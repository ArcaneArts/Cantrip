import { describe, expect, it, vi } from "vitest";
import { modelConfigurationSchema, type ChatMessage } from "@cantrip/protocol";
import {
  createChatTurnRuntime,
  type ChatTurnRuntimeDependencies,
} from "../src/app/runtime/chat-turn-runtime.js";
import {
  createTaskGoalRuntime,
  type TaskGoalRuntimeDependencies,
} from "../src/app/runtime/task-goal-runtime.js";
import type { ChatExecutionContext } from "../src/db/repository.js";
import { taskGoalWorkerInterrupted } from "../src/chats/execution-helpers.js";
import { WorkerUnavailableError } from "../src/workers/bridge.js";

const context = {
  chatId: "task-chat",
  experience: "task",
  contextKind: "project",
  projectId: "project",
  workerId: "worker",
  worktreeId: "worktree",
  executionLaneId: "lane",
  executionLaneActivatedAt: "2026-10-07T00:00:00.000Z",
  threadId: "native-thread",
  cwd: "/workspace",
  status: "running",
  automationPaused: false,
  reasoningEffort: null,
  modelConfiguration: modelConfigurationSchema.parse({ modelId: "model" }),
} as ChatExecutionContext;

const lease = {
  cycleId: "b907c938-796f-48be-bca2-ec36a9f25418",
  operationId: "finalize",
  leaseOwner: "server",
  fencingToken: 1,
  leaseExpiresAt: "2099-01-01T00:00:00.000Z",
};

describe("Task Goal worker interruption", () => {
  it("does not classify model errors, planning failures, or other chats as a lost implementation worker", () => {
    const lost = new WorkerUnavailableError(
      "Worker continuity identity changed.",
    );
    expect(taskGoalWorkerInterrupted("task", "goal", lost)).toBe(true);
    expect(taskGoalWorkerInterrupted("task", "plan", lost)).toBe(false);
    expect(taskGoalWorkerInterrupted("agent", "goal", lost)).toBe(false);
    expect(
      taskGoalWorkerInterrupted(
        "task",
        "goal",
        new Error("Native implementation failed."),
      ),
    ).toBe(false);
  });

  it.each([
    { ownsLane: true, workerLost: true },
    { ownsLane: false, workerLost: true },
    { ownsLane: true, workerLost: false },
  ])(
    "settles only transport interruptions as resumable: %o",
    async ({ ownsLane, workerLost }) => {
      const runtime = {
        routeId: "route",
        provider: { id: "provider", kind: "chatgpt", accountId: "account" },
        model: { id: "model", name: "model" },
      };
      const lost = workerLost
        ? new WorkerUnavailableError("Worker continuity identity changed.")
        : new Error("Native implementation failed.");
      const request = vi.fn().mockRejectedValue(lost);
      const finish = vi.fn().mockResolvedValue(ownsLane);
      const afterTurnFailed = vi.fn();
      const dispatch = vi.fn();
      const log = {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const userMessage = {
        id: "input",
        mode: "goal",
        content: [],
      } as unknown as ChatMessage;
      let background: Promise<unknown> | undefined;
      const deps = {
        app: { log },
        applicationOwnerId: () => "owner",
        bridge: { request },
        repository: {
          policies: {
            resolveEffective: vi.fn().mockResolvedValue({ policies: [] }),
          },
          listEffectiveMcpServers: vi.fn().mockResolvedValue([]),
          startChatExecutionLane: vi.fn().mockResolvedValue(context),
          finishChatExecutionLane: finish,
          listMessageHeaders: vi.fn().mockResolvedValue([]),
          getWorker: vi.fn().mockResolvedValue(null),
          updateChatRuntime: vi.fn(),
        },
        resolveModelId: vi.fn().mockResolvedValue("model"),
        routePairsForConfiguration: vi.fn().mockResolvedValue([
          {
            root: { runtime, adjusted: false, appliedReasoningEffort: null },
          },
          {
            root: {
              runtime: { ...runtime, routeId: "fallback" },
              adjusted: false,
              appliedReasoningEffort: null,
            },
          },
        ]),
        resolvePromptAttachments: vi.fn().mockResolvedValue([]),
        prepareCodeEditorsForTurn: vi.fn(),
        publishChatSummary: vi.fn(),
        publishChatTurnBoundary: vi.fn(),
        notifyCodeAgentState: vi.fn(),
        updateLiveChatPlanMode: vi.fn(),
        appendLiveTaskMessage: vi.fn().mockResolvedValue(userMessage),
        taskMessageServerStub: () => userMessage,
        setLiveTaskMessageModelRoute: vi.fn(),
        runtimeCanResumeContext: () => true,
        captureRuntimeQuota: vi.fn(),
        recordRuntimeTokenUsage: vi.fn(),
        recordRuntimeModelBehavior: vi.fn(),
        scheduleRuntimeQuotaSamples: vi.fn(),
        interruptLiveAgentInteractionRequests: vi.fn(),
        cancelChatTurnOutcomeRecovery: vi.fn(),
        dispatchNextQueuedPrompt: dispatch,
        continuePendingWorktreeTransition: vi.fn(),
        runAsOwner: (_owner: string, operation: () => Promise<unknown>) => {
          background = operation();
          return background;
        },
      } as unknown as ChatTurnRuntimeDependencies;
      await createChatTurnRuntime(deps).beginTurn(
        context,
        { text: "Continue", mode: "goal" },
        {
          encryptedTaskMessages: { userMessage: {} as never },
          afterTurnFailed,
        },
      );
      await background;
      expect(request).toHaveBeenCalledTimes(1); // No provider failover/replay on transport loss.
      expect(finish).toHaveBeenCalledWith(
        "task-chat",
        "lane",
        workerLost ? "idle" : "failed",
        workerLost
          ? {
              pauseAutomation: true,
              expectedActivatedAt: context.executionLaneActivatedAt,
            }
          : { pauseAutomation: false },
      );
      expect(dispatch).toHaveBeenCalledTimes(workerLost ? 0 : 1);
      expect(afterTurnFailed).toHaveBeenCalledTimes(ownsLane ? 1 : 0);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: workerLost ? "chat.turn.interrupted" : "chat.turn.failed",
          reasonCode: workerLost ? "worker-unavailable" : "execution-failed",
          status: workerLost ? "interrupted" : "failed",
        }),
        expect.any(String),
      );
    },
  );

  it("retains a scheduled implementation as resumable without requiring the offline worker", async () => {
    const pause = vi.fn();
    const settle = vi.fn();
    const request = vi.fn();
    const deps = {
      applicationOwnerId: () => "owner",
      bridge: { request },
      repository: {
        getChatExecutionContext: vi
          .fn()
          .mockResolvedValue({ ...context, automationPaused: true }),
        tasks: { get: vi.fn().mockResolvedValue({}) },
        taskDispatch: { pause, settle },
      },
      publishChatInvalidation: vi.fn(),
      queueTaskScheduleTick: vi.fn(),
    } as unknown as TaskGoalRuntimeDependencies;
    const runtime = createTaskGoalRuntime(deps);
    try {
      await runtime.scheduledTaskGoalTurnOptions(lease).afterTurnFailed({
        execution: context,
        error: new WorkerUnavailableError("Worker disconnected."),
      });
      expect(pause).toHaveBeenCalledWith(lease, {
        threadId: "native-thread",
        turnId: null,
      });
      expect(settle).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      runtime.close();
    }
  });
});
