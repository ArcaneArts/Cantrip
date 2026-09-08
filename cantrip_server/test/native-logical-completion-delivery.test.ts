import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeLogicalCompletionDelivery,
  type NativeLogicalCompletion,
  type NativeLogicalCompletionOutbox,
} from "../src/app/runtime/native-logical-completion-delivery.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const entry = (root = "root", worker = "worker"): NativeLogicalCompletion => ({
  ownerId: "owner",
  workerId: worker,
  chatId: "chat",
  rootOperationId: root,
  rootOperationGeneration: `${root}-generation`,
  attempts: 0,
});

function fixture(entries = [entry()]) {
  const rows = new Map(
    entries.map((row) => [row.rootOperationId, { ...row, due: Date.now() }]),
  );
  const repository: NativeLogicalCompletionOutbox = {
    listPendingLogicalCompletions: vi.fn(async (limit) =>
      [...rows.values()].filter((row) => row.due <= Date.now()).slice(0, limit),
    ),
    acknowledgeLogicalCompletion: vi.fn(
      async (owner, worker, chat, root, generation) => {
        const row = rows.get(root);
        if (
          !row ||
          row.ownerId !== owner ||
          row.workerId !== worker ||
          row.chatId !== chat ||
          row.rootOperationGeneration !== generation
        )
          return false;
        return rows.delete(root);
      },
    ),
    deferLogicalCompletion: vi.fn(
      async (owner, worker, chat, root, generation, next) => {
        const row = rows.get(root);
        if (
          !row ||
          row.ownerId !== owner ||
          row.workerId !== worker ||
          row.chatId !== chat ||
          row.rootOperationGeneration !== generation
        )
          return false;
        row.attempts++;
        row.due = next.getTime();
        return true;
      },
    ),
  };
  const request = vi.fn<WorkerCommandBus["request"]>().mockResolvedValue({});
  const onError = vi.fn();
  const create = () =>
    createNativeLogicalCompletionDelivery({
      repository,
      bridge: { request },
      onError,
    });
  return { rows, repository, request, onError, create };
}

afterEach(() => vi.useRealTimers());

describe("durable native logical completion delivery", () => {
  it("retries a dropped first acknowledgment without another user or reconnect event", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("reply was lost"));
    const delivery = f.create();
    delivery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.rows.size).toBe(1);
    expect(f.repository.acknowledgeLogicalCompletion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.rows.size).toBe(0);
    expect(f.request.mock.calls[0]).toEqual(f.request.mock.calls[1]);
    expect(f.request).toHaveBeenCalledWith(
      "worker",
      {
        type: "chat.native-logical.complete",
        chatId: "chat",
        rootOperationId: "root",
        rootOperationGeneration: "root-generation",
      },
      { ownerId: "owner", timeoutMs: 10_000 },
    );
    delivery.stop();
  });

  it("reconstructs pending delivery from durable rows after server restart", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("worker offline"));
    const first = f.create();
    await first.runOnce();
    first.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    const restarted = f.create();
    await restarted.runOnce();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.rows.size).toBe(0);
    restarted.stop();
  });

  it("delivers other roots while one worker acknowledgment is still pending", async () => {
    const f = fixture([entry("slow", "offline"), entry("ready", "online")]);
    let finish!: (value: unknown) => void;
    f.request.mockImplementation((worker) =>
      worker === "offline"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({}),
    );
    const delivery = f.create();
    const pending = delivery.runOnce();
    await vi.waitFor(() => expect(f.rows.has("ready")).toBe(false));
    expect(f.rows.has("slow")).toBe(true);
    finish({});
    await pending;
    expect(f.rows.size).toBe(0);
    delivery.stop();
  });

  it("keeps a completion pending if saving its acknowledgment fails", async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.repository.acknowledgeLogicalCompletion).mockRejectedValueOnce(
      new Error("database temporarily unavailable"),
    );
    const delivery = f.create();
    await delivery.runOnce();
    expect(f.rows.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await delivery.runOnce();
    expect(f.rows.size).toBe(0);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(
      f.request.mock.calls.every(
        ([, command]) => command.type === "chat.native-logical.complete",
      ),
    ).toBe(true);
    delivery.stop();
  });

  it("retains exact generations for older and newer roots in the same chat", async () => {
    const f = fixture([entry("old"), entry("new")]);
    const delivery = f.create();
    await delivery.runOnce();
    expect(f.repository.acknowledgeLogicalCompletion).toHaveBeenCalledWith(
      "owner",
      "worker",
      "chat",
      "old",
      "old-generation",
    );
    expect(f.repository.acknowledgeLogicalCompletion).toHaveBeenCalledWith(
      "owner",
      "worker",
      "chat",
      "new",
      "new-generation",
    );
    expect(f.request.mock.calls.map(([, command]) => command.type)).toEqual([
      "chat.native-logical.complete",
      "chat.native-logical.complete",
    ]);
    delivery.stop();
  });

  it("does not lose its row or start more delivery when shutdown wins an in-flight reply", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const delivery = f.create();
    const pending = delivery.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    delivery.stop();
    finish({});
    await pending;
    await vi.advanceTimersByTimeAsync(30_000);
    delivery.start();
    await delivery.runOnce();
    expect(f.rows.size).toBe(1);
    expect(f.repository.acknowledgeLogicalCompletion).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("retries failed reads and coalesces overlapping sweeps", async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.repository.listPendingLogicalCompletions).mockRejectedValueOnce(
      new Error("read failed"),
    );
    const delivery = f.create();
    const first = delivery.runOnce();
    expect(delivery.runOnce()).toBe(first);
    await first;
    expect(f.request).not.toHaveBeenCalled();
    delivery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.rows.size).toBe(0);
    expect(f.onError).toHaveBeenCalledTimes(1);
    delivery.stop();
  });
});
