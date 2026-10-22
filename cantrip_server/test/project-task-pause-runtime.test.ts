import { describe, expect, it, vi } from "vitest";
import type { ChatExecutionContext } from "../src/db/repository.js";
import type { TaskOpaqueSummary } from "@cantrip/protocol/tasks";
import { createChatAutomationPauseRuntime } from "../src/app/runtime/chat-automation-pause-runtime.js";
import { createProjectTaskPauseRuntime } from "../src/app/runtime/project-task-pause-runtime.js";

function fixture() {
  const contexts = new Map<string, ChatExecutionContext>();
  const tasks: TaskOpaqueSummary[] = [];
  const published: string[] = [];
  const workerCommands: { chatId: string; paused: boolean }[] = [];
  const failingChats = new Set<string>();
  const mismatchingChats = new Set<string>();
  const pause = vi.fn(async () => {});
  const pauseUnstarted = vi.fn(async () => {});
  const resumeAutomation = vi.fn(async () => {});
  const repository = {
    tasks: { list: vi.fn(async () => tasks) },
    taskDispatch: { pause, pauseUnstarted },
    getChatExecutionContext: async (_ownerId: string, chatId: string) =>
      contexts.get(chatId) ?? null,
    listQueuedPrompts: async () => [],
    setChatAutomationPaused: async (
      _ownerId: string,
      chatId: string,
      paused: boolean,
    ) => {
      const context = contexts.get(chatId);
      if (!context) return null;
      const updated = { ...context, automationPaused: paused };
      contexts.set(chatId, updated);
      return updated;
    },
    nativeCommands: {
      controlContext: async (_ownerId: string, chatId: string) => ({
        context: contexts.get(chatId),
        activationGeneration: null,
        runtimeGeneration: null,
      }),
    },
  };
  const publishChatSummary = (chatId: string) => {
    published.push(chatId);
  };
  const setChatAutomationPause = createChatAutomationPauseRuntime(
    {
      repository: repository as never,
      publishChatSummary,
      resumeChatAutomation: resumeAutomation,
      bridge: {
        isConnected: () => true,
        request: (async (
          _workerId: string,
          command: { chatId: string; paused: boolean },
        ) => {
          workerCommands.push(command);
          if (failingChats.has(command.chatId))
            throw new Error("Worker rejected the control");
          return {
            paused: mismatchingChats.has(command.chatId)
              ? !command.paused
              : command.paused,
            active: { threadId: command.chatId, turnId: "turn" },
          };
        }) as never,
      },
    },
    { log: { info: vi.fn() } } as never,
  );
  const setProjectPaused = createProjectTaskPauseRuntime({
    repository: repository as never,
    publishChatSummary,
    setChatAutomationPause,
    publishChatInvalidation: vi.fn(),
    releaseTaskGoalLease: vi.fn(),
    taskDispatchCycleLease: () => ({
      cycleId: "cycle",
      operationId: "operation",
      fencingToken: 1,
      leaseOwner: "server",
      leaseExpiresAt: "2100-01-01T00:00:00Z",
    }),
  });
  const add = (
    chatId: string,
    options: {
      state?: TaskOpaqueSummary["state"];
      status?: string;
      paused?: boolean;
      projectId?: string;
      dispatch?: TaskOpaqueSummary["dispatch"];
    } = {},
  ) => {
    tasks.push({
      chatId,
      state: options.state ?? "implementing",
      dispatch: options.dispatch ?? null,
    } as TaskOpaqueSummary);
    contexts.set(chatId, {
      chatId,
      projectId: options.projectId ?? "project",
      contextKind: "project",
      experience: "task",
      status: options.status ?? "running",
      threadId: chatId,
      workerId: "worker",
      automationPaused: options.paused ?? false,
    } as ChatExecutionContext);
  };
  return {
    add,
    contexts,
    failingChats,
    mismatchingChats,
    pause,
    pauseUnstarted,
    published,
    resumeAutomation,
    setProjectPaused,
    tasks,
    workerCommands,
  };
}

describe("project Task pause orchestration", () => {
  it("pauses and resumes every active Chat, including Goals between turns without a live dispatch", async () => {
    const f = fixture();
    f.add("direct");
    f.add("goal", { status: "ready" });
    f.add("manually-paused", {
      state: "paused",
      paused: true,
      status: "ready",
    });
    f.add("complete", { state: "complete", status: "ready" });
    f.add("draft", { state: "draft", status: "ready" });
    f.add("queued", {
      state: "draft",
      status: "ready",
      dispatch: { state: "queued" } as never,
    });
    f.add("another-project", { projectId: "another-project" });
    await f.setProjectPaused("owner", "project", true);
    expect(f.workerCommands.map(({ chatId }) => chatId)).toEqual([
      "direct",
      "goal",
      "manually-paused",
    ]);
    for (const chatId of ["direct", "goal", "manually-paused"]) {
      expect(f.contexts.get(chatId)?.automationPaused).toBe(true);
      expect(f.published).toContain(chatId);
    }
    await f.setProjectPaused("owner", "project", false);
    expect(
      f.workerCommands.slice(3).map(({ chatId, paused }) => [chatId, paused]),
    ).toEqual([
      ["direct", false],
      ["goal", false],
      ["manually-paused", false],
    ]);
    expect(f.resumeAutomation.mock.calls).toEqual([
      ["direct"],
      ["goal"],
      ["manually-paused"],
    ]);
    for (const chatId of ["direct", "goal", "manually-paused"]) {
      expect(f.contexts.get(chatId)?.automationPaused).toBe(false);
    }
    expect(f.contexts.get("another-project")?.automationPaused).toBe(false);
  });

  it.each([true, false])(
    "attempts all Tasks when one worker fails paused=%s",
    async (paused) => {
      const f = fixture();
      f.add("failing", { paused: !paused });
      f.add("healthy", { paused: !paused });
      f.failingChats.add("failing");
      await expect(
        f.setProjectPaused("owner", "project", paused),
      ).rejects.toThrow("1 Task could not");
      expect(f.workerCommands.map(({ chatId }) => chatId)).toEqual([
        "failing",
        "healthy",
      ]);
      expect(f.contexts.get("failing")?.automationPaused).toBe(!paused);
      expect(f.contexts.get("healthy")?.automationPaused).toBe(paused);
      expect(f.published).toContain("healthy");
    },
  );

  it("does not report a Task paused when the worker acknowledges the opposite state", async () => {
    const f = fixture();
    f.add("mismatch");
    f.mismatchingChats.add("mismatch");
    await expect(f.setProjectPaused("owner", "project", true)).rejects.toThrow(
      "did not acknowledge",
    );
    expect(f.contexts.get("mismatch")?.automationPaused).toBe(false);
    expect(f.published).toEqual([]);
  });

  it("leaves paused dispatches to the scheduler so Resume cannot bypass capacity or lease acquisition", async () => {
    const f = fixture();
    f.add("scheduled", {
      paused: true,
      dispatch: { state: "paused" } as never,
    });
    f.add("unscheduled", { paused: true });
    await f.setProjectPaused("owner", "project", false);
    expect(f.workerCommands.map(({ chatId }) => chatId)).toEqual([
      "unscheduled",
    ]);
    expect(f.contexts.get("scheduled")?.automationPaused).toBe(true);
    expect(f.contexts.get("unscheduled")?.automationPaused).toBe(false);
  });

  it("persists and publishes the pause for a claim that has not reached the worker", async () => {
    const f = fixture();
    f.add("claimed", {
      status: "ready",
      state: "planning",
      dispatch: {
        id: "cycle",
        state: "claimed",
        codexThreadId: null,
        turnId: null,
      } as never,
    });
    await f.setProjectPaused("owner", "project", true);
    expect(f.pauseUnstarted).toHaveBeenCalledOnce();
    expect(f.contexts.get("claimed")?.automationPaused).toBe(true);
    expect(f.published).toContain("claimed");
    expect(f.workerCommands).toEqual([]);
  });
});
