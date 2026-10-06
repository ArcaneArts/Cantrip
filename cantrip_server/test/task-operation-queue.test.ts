import { describe, expect, it, vi } from "vitest";
import type {
  TaskOpaqueSummary,
  TaskOperationStart,
} from "@cantrip/protocol/tasks";
import { createTaskOperationQueue } from "../src/app/runtime/task-operation-queue.js";

describe("task title submission boundary", () => {
  function fixture() {
    const task = { chatId: "chat", rowVersion: 2 } as TaskOpaqueSummary;
    const enqueue = vi.fn().mockResolvedValue(null);
    const get = vi.fn().mockResolvedValue(task);
    const nameTask = vi.fn();
    const tick = vi.fn();
    const publish = vi.fn();
    const queue = createTaskOperationQueue({
      repository: { taskDispatch: { enqueue }, tasks: { get } },
      applicationOwnerId: () => "owner",
      nameTask,
      queueTaskScheduleTick: tick,
      publishChatInvalidation: publish,
    } as unknown as Parameters<typeof createTaskOperationQueue>[0]);
    const input = {
      operationId: "operation",
      rowVersion: 2,
    } as TaskOperationStart;
    return { task, enqueue, get, nameTask, tick, publish, queue, input };
  }
  it.each(["direct", "initial-plan", "continue-plan", "finalize"] as const)(
    "labels only first user submissions (%s)",
    async (kind) => {
      const f = fixture();
      expect(await f.queue("chat", f.input, kind)).toEqual(f.task);
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
        "owner",
        "chat",
        "operation",
        kind,
        2,
      );
      expect(f.nameTask).toHaveBeenCalledTimes(
        kind === "direct" || kind === "initial-plan" ? 1 : 0,
      );
      expect(f.tick).toHaveBeenCalledTimes(1);
      expect(f.publish).toHaveBeenCalledExactlyOnceWith("chat", "task");
    },
  );
  it("does not name or schedule a rejected submission", async () => {
    const f = fixture();
    f.enqueue.mockRejectedValue(new Error("stale version"));
    await expect(f.queue("chat", f.input, "direct")).rejects.toThrow(
      "stale version",
    );
    expect(f.nameTask).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.tick).not.toHaveBeenCalled();
  });
});
