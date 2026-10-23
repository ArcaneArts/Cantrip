import { describe, expect, it, vi } from "vitest";
import { modelConfigurationSchema } from "@cantrip/protocol";
import {
  createTaskGoalRuntime,
  type TaskGoalRuntimeDependencies,
} from "../src/app/runtime/task-goal-runtime.js";
import { TaskConflictError } from "../src/db/tasks.js";
import type { ChatExecutionContext } from "../src/db/repository.js";
import type { TaskOpaqueSummary } from "@cantrip/protocol/tasks";

const protect = vi.hoisted(() => vi.fn());
vi.mock("../src/app/runtime/protect-chat-input.js", () => ({
  protectChatInput: protect,
}));
const cipher = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

function fixture() {
  const classification = {
    state: "implementing",
    stableStateBeforeFailure: null,
    activeOperationKind: null,
    planAuthorship: "agent",
    planningRound: 1,
    hasPlan: true,
    hasQuestions: false,
    hasFinalPlan: true,
    hasGoalPrompt: true,
    lastError: null,
  };
  const opaque = { classification, protectedContent: cipher };
  const userMessage = {
    id: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "continuation",
    classification: { role: "system", mode: "goal", attachmentIds: [] },
    protectedContent: cipher,
  };
  protect.mockResolvedValue(userMessage);
  const sourceGoal = {
    classification: {
      chatId: "chat",
      threadId: "finalizer-thread",
      status: "active",
    },
    protectedObjective: cipher,
    startMessage: {
      ...userMessage,
      classification: { ...userMessage.classification, role: "user" },
    },
  };
  const task = {
    ...classification,
    protectedContent: cipher,
    rowVersion: 1,
    chatId: "chat",
    planGoalEnabled: true,
    implementationStartedAt: "2026-10-22T00:00:00Z",
    dispatch: {
      id: "11111111-1111-4111-8111-111111111111",
      operationId: "33333333-3333-4333-8333-333333333333",
      operationKind: "finalize",
      state: "running",
      leaseOwner: "server",
      leaseExpiresAt: "2099-01-01T00:00:00Z",
      fencingToken: 1,
      modelConfiguration: modelConfigurationSchema.parse({ modelId: "model" }),
    },
  } as unknown as TaskOpaqueSummary;
  const context = {
    chatId: "chat",
    experience: "task",
    contextKind: "project",
    projectId: "project",
    workerId: "worker",
    worktreeId: "worktree",
    threadId: "native-thread",
    cwd: "/worktree",
    status: "idle",
    automationPaused: false,
    modelConfiguration: task.dispatch!.modelConfiguration,
    reasoningEffort: null,
    permissionProfileId: "full-access",
  } as ChatExecutionContext;
  const goal = {
    chatId: "chat",
    threadId: "native-thread",
    status: "active",
    protectedObjective: cipher,
    tokenBudget: null,
    tokensUsed: 1,
    timeUsedSeconds: 2,
    createdAt: 1,
    updatedAt: 2,
  };
  const request = vi.fn(async (worker: string, command: { type: string }) => {
    if (command.type === "task.message.protect") return userMessage;
    return { goal, task: opaque, message: null };
  });
  const repository = {
    getChatExecutionContext: vi.fn(async () => context),
    updateChatRuntime: vi.fn(async () => {}),
    getPendingChatWorktreeTransition: vi.fn(async () => null as unknown),
    tasks: {
      get: vi.fn(async () => task),
      syncImplementationState: vi.fn(async () => task),
      getOperationContext: vi.fn(async () => ({
        round: { kind: "finalize" },
        relayResult: { goal: sourceGoal },
      })),
    },
    taskDispatch: {
      heartbeat: vi.fn(async () => ({})),
      settle: vi.fn(async () => ({})),
      recoverStartedGoal: vi.fn(),
    },
  };
  const beginTurn = vi.fn(async () => ({}));
  const runtime = {
    routeId: "route",
    model: { id: "model", name: "Model" },
    provider: { id: "provider", kind: "chatgpt", accountId: null },
  };
  const goals = createTaskGoalRuntime({
    repository,
    bridge: { request },
    beginTurn,
    applicationOwnerId: () => "owner",
    app: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    runtimeForContext: vi.fn(async () => runtime),
    resolveModelId: vi.fn(async () => "model"),
    routePairsForConfiguration: vi.fn(async () => [{ root: { runtime } }]),
    runtimeCanResumeContext: vi.fn(() => false),
    publishChatInvalidation: vi.fn(),
    queueTaskScheduleTick: vi.fn(),
  } as unknown as TaskGoalRuntimeDependencies);
  return {
    goals,
    task,
    context,
    goal,
    opaque,
    repository,
    request,
    beginTurn,
    sourceGoal,
  };
}

describe("encrypted Task Goal observation and handoff", () => {
  it("persists a real failed turn even when its Goal attachment has disappeared", async () => {
    const f = fixture();
    const failed = {
      ...f.opaque,
      classification: { ...f.opaque.classification, state: "failed" },
    };
    f.request.mockResolvedValue({
      goal: null,
      task: failed,
      message: null,
    } as never);
    f.repository.tasks.syncImplementationState.mockResolvedValue({
      ...f.task,
      state: "failed",
    });
    const result = await f.goals.readEncryptedTaskGoal(
      f.context,
      f.task,
      null,
      false,
      false,
      { kind: "timeout", occurredAt: "2026-10-22T00:00:00.000Z" },
    );
    expect(result.goal).toBeNull();
    expect(result.task.state).toBe("failed");
    expect(f.repository.tasks.syncImplementationState).toHaveBeenCalledWith(
      "owner",
      "chat",
      { rowVersion: 1, task: failed },
    );
  });
  it("accepts an absent Goal without synchronizing or inventing completion", async () => {
    const f = fixture();
    f.request.mockResolvedValue({
      goal: null,
      task: f.opaque,
      message: null,
    } as never);
    try {
      expect(
        await f.goals.readEncryptedTaskGoal(f.context, f.task),
      ).toMatchObject({ goal: null, task: f.task });
      expect(f.repository.tasks.syncImplementationState).not.toHaveBeenCalled();
      expect(f.repository.taskDispatch.settle).not.toHaveBeenCalled();
    } finally {
      f.goals.close();
    }
  });
  it("does not turn a successful observation into an error when a parallel status read wins the Task CAS", async () => {
    const f = fixture();
    f.repository.tasks.syncImplementationState.mockRejectedValueOnce(
      new TaskConflictError("race", "stale-version"),
    );
    try {
      expect(
        (await f.goals.readEncryptedTaskGoal(f.context, f.task)).goal?.status,
      ).toBe("active");
    } finally {
      f.goals.close();
    }
  });
  it("does not suppress mutation conflicts or another thread's metadata", async () => {
    const f = fixture();
    try {
      f.repository.tasks.syncImplementationState.mockRejectedValueOnce(
        new TaskConflictError("race", "stale-version"),
      );
      await expect(
        f.goals.readEncryptedTaskGoal(f.context, f.task, null, false, true),
      ).rejects.toThrow("race");
      f.request.mockResolvedValue({
        goal: { ...f.goal, threadId: "other" },
        task: f.opaque,
        message: null,
      } as never);
      await expect(
        f.goals.readEncryptedTaskGoal(f.context, f.task),
      ).rejects.toThrow("metadata is invalid");
    } finally {
      f.goals.close();
    }
  });
  it("restores the canonical encrypted objective and admits a Goal-mode handoff, not a default-mode turn", async () => {
    const f = fixture();
    try {
      expect(
        await f.goals.continueTaskGoalInWorktree(
          { ...f.context, threadId: null },
          {
            text: "Continue in the destination worktree",
            idempotencyKey: "continuation",
          },
        ),
      ).toBe(true);
      expect(f.request).toHaveBeenCalledWith(
        "worker",
        expect.objectContaining({
          type: "chat.goal.create",
          threadId: null,
          objective: f.sourceGoal,
        }),
      );
      expect(f.beginTurn).toHaveBeenCalledWith(
        f.context,
        expect.objectContaining({
          mode: "goal",
          idempotencyKey: "continuation",
        }),
        expect.objectContaining({
          messageRole: "system",
          workerPrompt: expect.stringContaining("destination worktree"),
          taskDispatchLease: expect.objectContaining({ fencingToken: 1 }),
          encryptedTaskMessages: expect.objectContaining({
            userMessage: expect.objectContaining({
              classification: expect.objectContaining({ mode: "goal" }),
            }),
          }),
        }),
      );
      expect(f.repository.tasks.syncImplementationState).toHaveBeenCalledOnce();
    } finally {
      f.goals.close();
    }
  });
  it("retains capacity for a pending worktree handoff instead of settling it as blocked", async () => {
    const f = fixture();
    f.repository.getPendingChatWorktreeTransition.mockResolvedValue({
      lane: { id: "handoff" },
    });
    try {
      await f.goals.reconcileTaskGoalDispatch(f.task, "blocked");
      expect(f.repository.taskDispatch.heartbeat).toHaveBeenCalled();
      expect(f.repository.taskDispatch.settle).not.toHaveBeenCalled();
    } finally {
      f.goals.close();
    }
  });
  it("does not start work for a completed Task or a failed Goal restoration", async () => {
    const f = fixture();
    try {
      f.task.state = "complete";
      expect(
        await f.goals.continueTaskGoalInWorktree(f.context, {
          text: "Continue",
          idempotencyKey: "continuation",
        }),
      ).toBe(true);
      expect(f.beginTurn).not.toHaveBeenCalled();
      f.task.state = "blocked";
      f.request.mockRejectedValue(new Error("Worker offline"));
      await expect(
        f.goals.continueTaskGoalInWorktree(f.context, {
          text: "Continue",
          idempotencyKey: "continuation",
        }),
      ).rejects.toThrow("Worker offline");
      expect(f.beginTurn).not.toHaveBeenCalled();
      expect(f.repository.taskDispatch.settle).toHaveBeenCalledWith(
        expect.anything(),
        "failed",
      );
    } finally {
      f.goals.close();
    }
  });
});
