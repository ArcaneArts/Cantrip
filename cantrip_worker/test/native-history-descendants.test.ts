import { describe, expect, it, vi } from "vitest";
import type { NativeHistoryBinding } from "@cantrip/protocol";
import { NativeHistoryDescendants } from "../src/native-history-descendants.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";
import type { NativeHistoryRuntime } from "../src/managed-native-history-sources.js";
import type { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";

function fixture() {
  let generation = "runtime-one";
  const headers: Record<string, string | null> = {
    root: null,
    child: "root",
    grandchild: "child",
    unrelated: null,
  };
  const read = vi.fn(async (id: string) =>
    parseCodexNativeHistory(
      {
        thread: {
          id,
          parentThreadId: headers[id] ?? null,
          status: { type: "idle" },
          turns: [],
        },
      },
      id,
    ),
  );
  const runtime = {
    get transportGeneration() {
      return generation;
    },
    readNativeHistory: read,
  } as unknown as NativeHistoryRuntime;
  const bindings = new Map<string, NativeHistoryBinding>();
  const open = vi.fn(async (input) => {
    let binding = bindings.get(input.threadId);
    if (!binding) {
      const parent = [...bindings.values()].find(
        (row) => row.id === input.provenance.parentBindingId,
      );
      if (input.provenance.kind === "child" && !parent)
        throw new Error("Parent missing");
      binding = {
        id: `binding-${input.threadId}`,
        chatId: "chat",
        workerId: "worker",
        threadId: input.threadId,
        projectId: "project",
        worktreeId: "worktree",
        modelRouteId: null,
        providerAccountId: null,
        createdFromOperationId: null,
        createdAt: new Date(0).toISOString(),
        ...(parent
          ? {
              ancestorThreadIds: [
                ...(parent.ancestorThreadIds ?? []),
                parent.threadId,
              ],
            }
          : {}),
      };
      bindings.set(input.threadId, binding);
    }
    return binding;
  });
  const reconcile = vi.fn();
  const bind = vi.fn(() => ({ reconcile }));
  const onError = vi.fn();
  const owner = new NativeHistoryDescendants({
    client: { open },
    bind,
    onError,
    retryDelayMs: 1,
  });
  const root = { runtime, chatId: "chat", threadId: "root" };
  return {
    owner,
    root,
    read,
    open,
    bind,
    reconcile,
    bindings,
    onError,
    replace: () => {
      generation = "runtime-two";
    },
  };
}

describe("native descendant discovery", () => {
  it("verifies real headers rootward, binds parent-first, and deduplicates reads while reconciling later references", async () => {
    const f = fixture();
    try {
      const [a, b] = await Promise.all([
        f.owner.resolve(f.root, "grandchild"),
        f.owner.resolve(f.root, "grandchild"),
      ]);
      expect(a).toEqual(b);
      expect(f.read.mock.calls.map(([id]) => id)).toEqual([
        "grandchild",
        "child",
      ]);
      expect(f.open.mock.calls.map(([input]) => input.threadId)).toEqual([
        "root",
        "child",
        "grandchild",
      ]);
      expect(f.bindings.get("grandchild")?.ancestorThreadIds).toEqual([
        "root",
        "child",
      ]);
      expect(f.reconcile).toHaveBeenCalledTimes(2);
      await f.owner.resolve(f.root, "grandchild");
      expect(f.read).toHaveBeenCalledTimes(2);
      expect(f.reconcile).toHaveBeenCalledTimes(3);
    } finally {
      await f.owner.stop();
    }
  });

  it("does not bind an unrelated native root just because an activity mentions its ID", async () => {
    const f = fixture();
    try {
      await expect(f.owner.resolve(f.root, "unrelated")).rejects.toThrow(
        "verify its parent",
      );
      expect(f.open).not.toHaveBeenCalled();
      expect(f.bind).not.toHaveBeenCalled();
    } finally {
      await f.owner.stop();
    }
  });

  it("retries an actual failed read without caching failure or making native input calls", async () => {
    const f = fixture();
    try {
      f.read.mockRejectedValueOnce(new Error("temporary native read failure"));
      await expect(f.owner.resolve(f.root, "child")).rejects.toThrow(
        "temporary native read failure",
      );
      expect(f.open).not.toHaveBeenCalled();
      await expect(f.owner.resolve(f.root, "child")).resolves.toMatchObject({
        threadId: "child",
      });
      expect(f.read).toHaveBeenCalledTimes(2);
    } finally {
      await f.owner.stop();
    }
  });

  it("rejects replaced transport evidence and abandons pending native reads on stop", async () => {
    const f = fixture();
    let resolve!: (value: Awaited<ReturnType<typeof f.read>>) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const attempt = f.owner.resolve(f.root, "child");
    const failed = expect(attempt).rejects.toThrow("transport was replaced");
    f.replace();
    resolve(
      parseCodexNativeHistory(
        {
          thread: {
            id: "child",
            parentThreadId: "root",
            status: { type: "idle" },
            turns: [],
          },
        },
        "child",
      ),
    );
    await failed;
    f.read.mockImplementationOnce(() => new Promise(() => {}));
    const stopped = expect(f.owner.resolve(f.root, "child")).rejects.toThrow(
      "discovery stopped",
    );
    await f.owner.stop();
    await stopped;
    expect(f.bind).not.toHaveBeenCalled();
  });

  it("skips disproven candidates but retries a failed journal read before consuming discovery records", async () => {
    const f = fixture();
    const records = ["unrelated", "child"].map((id, index) => ({
      sequence: index + 1,
      frame: {
        kind: "notification",
        params: {
          item: {
            type: "subAgentActivity",
            kind: "started",
            agentThreadId: id,
          },
        },
      },
    }));
    const read = vi.fn(async (after: number) => records.slice(after));
    read.mockRejectedValueOnce(new Error("temporary source read failure"));
    const source = {
      journalId: "journal",
      head: async () => ({ sequence: 2 }),
      read,
    } as unknown as NativeHistorySourceJournal;
    try {
      f.owner.wake(
        source,
        { chatId: "chat", threadId: "root", bindingId: "binding-root" },
        f.root.runtime,
      );
      await f.owner.flush();
      expect(f.bindings.get("child")?.ancestorThreadIds).toEqual(["root"]);
      expect(f.bindings.has("unrelated")).toBe(false);
      expect(read.mock.calls.map(([after]) => after)).toEqual([0, 0]);
      expect(f.onError).toHaveBeenCalledTimes(2);
    } finally {
      await f.owner.stop();
    }
  });
});
