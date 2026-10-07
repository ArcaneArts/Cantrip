import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { TaskQueryInvalidation } from "./task-query-invalidation";

const settle = async () => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

function fixture(key = ["project-task-workload", "project"] as const) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const reads: Array<{ finish(value: number): void; signal: AbortSignal }> = [];
  const observer = new QueryObserver(client, {
    queryKey: key,
    initialData: 0,
    queryFn: ({ signal }) =>
      new Promise<number>((finish) => reads.push({ finish, signal })),
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    client,
    invalidation: new TaskQueryInvalidation(client),
    observer,
    reads,
    close: () => {
      unsubscribe();
      client.clear();
    },
  };
}

describe("Task live read backpressure", () => {
  it("settles earlier hints even when a continuous stream queues another trailing read", async () => {
    const f = fixture();
    try {
      const first = f.invalidation.invalidate(["project-task-workload"]);
      await settle();
      const second = f.invalidation.invalidate(["project-task-workload"]);
      f.reads[0]!.finish(1);
      await first;
      await settle();
      const third = f.invalidation.invalidate(["project-task-workload"]);
      f.reads[1]!.finish(2);
      await second;
      await settle();
      expect(f.reads).toHaveLength(3);
      expect(f.client.getQueryData(["project-task-workload", "project"])).toBe(
        2,
      );
      f.reads[2]!.finish(3);
      await third;
    } finally {
      f.close();
    }
  });

  it("coalesces chat/project hints across event-loop ticks and refreshes the trailing snapshot", async () => {
    const f = fixture();
    try {
      const completions = [
        f.invalidation.invalidate(["project-task-workload"]),
      ];
      await settle();
      expect(f.reads).toHaveLength(1);
      for (let index = 0; index < 100; index += 1) {
        completions.push(
          f.invalidation.invalidate(
            index % 2
              ? ["project-task-workload", "project"]
              : ["project-task-workload"],
          ),
        );
        await settle();
      }
      expect(f.reads).toHaveLength(1);
      expect(f.reads[0]!.signal.aborted).toBe(false);
      f.reads[0]!.finish(1);
      await settle();
      expect(f.reads).toHaveLength(2);
      f.reads[1]!.finish(100);
      await Promise.all(completions);
      expect(f.client.getQueryData(["project-task-workload", "project"])).toBe(
        100,
      );

      const next = f.invalidation.invalidate(["project-task-workload"]);
      await settle();
      expect(f.reads).toHaveLength(3);
      f.reads[2]!.finish(101);
      await next;
    } finally {
      f.close();
    }
  });

  it("waits for a read started outside the bridge, then refreshes without cancelling it", async () => {
    const f = fixture();
    try {
      const initial = f.observer.refetch();
      await settle();
      const completion = f.invalidation.invalidate(["project-task-workload"]);
      await settle();
      expect(f.reads).toHaveLength(1);
      expect(f.reads[0]!.signal.aborted).toBe(false);
      f.reads[0]!.finish(1);
      await initial;
      await settle();
      expect(f.reads).toHaveLength(2);
      f.reads[1]!.finish(2);
      await completion;
      expect(f.client.getQueryData(["project-task-workload", "project"])).toBe(
        2,
      );
    } finally {
      f.close();
    }
  });

  it("marks hidden queries stale without fetching and lets a later observer read fresh data", async () => {
    const client = new QueryClient();
    const key = ["task-dashboard", "task"];
    const read = vi.fn(async () => 2);
    const observer = new QueryObserver(client, {
      enabled: false,
      initialData: 1,
      queryKey: key,
      queryFn: read,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await new TaskQueryInvalidation(client).invalidate(key);
      expect(read).not.toHaveBeenCalled();
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      observer.setOptions({ enabled: true, queryKey: key, queryFn: read });
      await settle();
      expect(read).toHaveBeenCalledTimes(1);
      expect(client.getQueryData(key)).toBe(2);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("does not retain failed reads or change invalidation for unrelated query families", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidation = new TaskQueryInvalidation(client);
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(2);
    const observer = new QueryObserver(client, {
      queryKey: ["task", "task"],
      queryFn: read,
      initialData: 0,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await invalidation.invalidate(["task", "task"]);
      await invalidation.invalidate(["task", "task"]);
      expect(read).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(["task", "task"])).toBe(2);
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await invalidation.invalidate(["workers"]);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workers"] });
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
