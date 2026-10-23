import { describe, expect, it, vi } from "vitest";
import {
  createTaskAutomaticRetry,
  retryTaskOperation,
} from "../src/app/runtime/task-automatic-retry.js";
import { createTaskOperationQueue } from "../src/app/runtime/task-operation-queue.js";

function fixture(goal = false) {
  const task = {
    chatId: "chat",
    state: "failed",
    rowVersion: 1,
    planningRound: 1,
    planGoalEnabled: goal,
    implementationStartedAt: goal ? "2026-10-22T00:00:00Z" : null,
    automaticRetry: {
      status: "scheduled",
      failureKind: "timeout",
      nextAttemptAt: "2026-10-22T00:00:05Z",
      recentAttempts: 1,
    },
    lastError: {
      operationKind: goal ? "implementation" : "direct",
      code: "timeout",
      occurredAt: "2026-10-22T00:00:00Z",
    },
    dispatch: { codexThreadId: "native-thread" },
  };
  const repository = {
    getChatExecutionContext: vi.fn(async () => ({ threadId: "native-thread" })),
    tasks: {
      get: vi.fn(async () => task),
      listRounds: vi.fn(),
      getOperationContext: vi.fn(),
    },
    taskRetries: {
      listCandidates: vi.fn(async () => [
        { ownerId: "owner", projectId: "project", chatId: "chat" },
      ]),
      noteFailure: vi.fn(async () => false),
      claimDue: vi.fn(async () => ({ id: "claim", rowVersion: 1 })),
      finish: vi.fn(async () => true),
    },
  };
  const recover = vi.fn(async () => true),
    queue = vi.fn(async () => task);
  const observe = vi.fn(async () => ({
    execution: { threadId: "native-thread", status: "idle" },
  }));
  const runtime = createTaskAutomaticRetry({
    repository,
    recover,
    queue,
    observe,
    runAsOwner: (_owner, run) => run(),
    publish: vi.fn(),
    report: vi.fn(),
  } as unknown as Parameters<typeof createTaskAutomaticRetry>[0]);
  return { task, repository, recover, queue, observe, runtime };
}
describe("Task retry execution", () => {
  it("resets accounting for explicit user operations, never for automatic retries", async () => {
    const reset = vi.fn();
    const queue = createTaskOperationQueue({
      repository: {
        taskDispatch: { enqueue: vi.fn() },
        taskRetries: { reset },
        tasks: { get: vi.fn(async () => null) },
      },
      applicationOwnerId: () => "owner",
      publishChatInvalidation: vi.fn(),
      queueTaskScheduleTick: vi.fn(),
      nameTask: vi.fn(),
    } as never);
    await queue("chat", { operationId: "op", rowVersion: 1 }, "direct", {
      automatic: true,
    });
    expect(reset).not.toHaveBeenCalled();
    await queue("chat", { operationId: "op", rowVersion: 1 }, "direct");
    expect(reset).toHaveBeenCalledWith("owner", "chat");
  });
  it("uses automatic Goal recovery without impersonating a manual unpause", async () => {
    const f = fixture(true);
    await f.runtime.tick();
    await f.runtime.drain();
    expect(f.recover).toHaveBeenCalledWith("chat", true, true);
    expect(f.queue).not.toHaveBeenCalled();
  });
  it("observes the actual idle native execution before replaying an ordinary operation", async () => {
    const f = fixture();
    await f.runtime.tick();
    await f.runtime.drain();
    expect(f.observe).toHaveBeenCalled();
    expect(f.queue).toHaveBeenCalledWith(
      "chat",
      { operationId: "claim", rowVersion: 1 },
      "direct",
    );
  });
  it("defers without spending retries while the previous native execution is still running", async () => {
    const f = fixture();
    f.observe.mockResolvedValue({
      execution: { threadId: "native-thread", status: "running" },
    });
    await f.runtime.tick();
    await f.runtime.drain();
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.repository.taskRetries.finish).toHaveBeenCalledWith(
      "owner",
      "chat",
      "claim",
      { kind: "runtime", defer: true },
    );
  });
  it("does not start a new turn after a mismatched native observation", async () => {
    const f = fixture();
    f.observe.mockResolvedValue({
      execution: { threadId: "other-thread", status: "idle" },
    });
    await f.runtime.tick();
    await f.runtime.drain();
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.repository.taskRetries.finish).toHaveBeenCalledWith(
      "owner",
      "chat",
      "claim",
      { kind: "runtime", defer: false },
    );
  });
  it("reschedules a technical recovery failure through the persisted claim", async () => {
    const f = fixture(true);
    f.recover.mockRejectedValue(new Error("Worker request timed out"));
    await f.runtime.tick();
    await f.runtime.drain();
    expect(f.repository.taskRetries.finish).toHaveBeenCalledWith(
      "owner",
      "chat",
      "claim",
      { kind: "timeout", defer: false },
    );
  });
  it("deduplicates concurrent ticks and drains in-flight recovery at shutdown", async () => {
    const f = fixture(true);
    let finish!: () => void;
    f.recover.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => resolve(true);
        }),
    );
    await f.runtime.tick();
    await vi.waitFor(() => expect(f.recover).toHaveBeenCalledOnce());
    await f.runtime.tick();
    expect(f.repository.taskRetries.claimDue).toHaveBeenCalledOnce();
    f.runtime.stop();
    finish();
    await f.runtime.drain();
    await f.runtime.tick();
    expect(f.recover).toHaveBeenCalledOnce();
  });
  it("reuses the finalized relay operation instead of generating a second Goal", async () => {
    const f = fixture();
    f.task.lastError.operationKind = "finalize";
    f.repository.tasks.listRounds.mockResolvedValue([
      { id: "saved-finalizer", ordinal: 1 },
    ]);
    f.repository.tasks.getOperationContext.mockResolvedValue({
      relayResult: { goal: {} },
    });
    await retryTaskOperation(
      f.repository as never,
      "owner",
      f.task as never,
      f.queue as never,
      "new-attempt",
    );
    expect(f.queue).toHaveBeenCalledWith(
      "chat",
      { operationId: "saved-finalizer", rowVersion: 1 },
      "finalize",
    );
  });
});
