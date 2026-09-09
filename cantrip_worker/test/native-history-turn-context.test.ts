import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  NativeHistoryTurnContextIndex,
  resolveNativeHistoryTurnContext,
} from "../src/native-history-turn-context.js";
import type { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";
import type { NativeHistoryStateTurn } from "../src/native-history-state.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";

type Record = Awaited<ReturnType<NativeHistorySourceJournal["read"]>>[number];
const context = {
  cwd: "/original",
  model: "native-model",
  collaborationMode: "plan",
  reasoningEffort: "high",
  rootTurnId: "turn",
};
const turn = { id: "turn", metadata: null } as Omit<
  NativeHistoryStateTurn,
  "items"
>;
const snapshot = (sequence: number, contexts = [context]): Record => ({
  sequence,
  recordId: randomUUID(),
  frame: {
    kind: "snapshot",
    id: randomUUID(),
    threadId: "thread",
    generation: "runtime",
    readBarrierSequence: sequence,
    completedSequence: sequence,
    receivedAtMs: sequence,
    snapshot: parseCodexNativeHistory(
      {
        thread: { id: "thread", status: { type: "idle" }, turns: [] },
        history: {
          version: 1,
          currentTurnId: null,
          currentTurnState: "notLoaded",
          turns: [
            {
              turnId: "turn",
              source: "canonical",
              retention: "complete",
              contexts,
              items: [],
              usage: null,
              warnings: [],
              errors: [],
            },
          ],
        },
      },
      "thread",
    ),
  },
});
function fixture(initial: Record[]) {
  const records = [...initial];
  const head = vi.fn(async () => ({
    sequence: records.length,
    recordId: records.at(-1)?.recordId ?? null,
  }));
  const read = vi.fn(async (after = 0, limit = 128) =>
    structuredClone(records.slice(after, after + limit)),
  );
  const source = {
    scope: { threadId: "thread" },
    head,
    read,
  } as unknown as NativeHistorySourceJournal;
  return {
    records,
    head,
    read,
    source,
    index: new NativeHistoryTurnContextIndex(source),
  };
}

describe("durable native turn context indexing", () => {
  it("indexes beyond a projection page, reads incrementally and captures a finite head", async () => {
    const f = fixture(
      Array.from({ length: 513 }, (_, i) =>
        snapshot(i + 1, i === 512 ? [context] : []),
      ),
    );
    const actualRead = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce(async (...args) => {
      const page = await actualRead(...args);
      f.records.push(snapshot(514, [{ ...context, cwd: "/later" }]));
      return page;
    });
    await f.index.refresh();
    expect(f.read.mock.calls).toEqual([
      [0, 512],
      [512, 1],
    ]);
    expect(resolveNativeHistoryTurnContext(f.index.read(turn))).toEqual({
      cwd: "/original",
      mode: "plan",
      rootTurnId: "turn",
    });
    f.index.read(turn);
    f.index.read(turn);
    expect(f.head).toHaveBeenCalledTimes(1);
    await f.index.refresh();
    expect(f.read.mock.calls.at(-1)).toEqual([513, 1]);
    expect(() => resolveNativeHistoryTurnContext(f.index.read(turn))).toThrow(
      "disagree",
    );
    const rebuilt = new NativeHistoryTurnContextIndex(f.source);
    await rebuilt.refresh();
    expect(rebuilt.read(turn)).toEqual(f.index.read(turn));
  });

  it("retries failed I/O and checks finite boundary identity without consuming projection state", async () => {
    const f = fixture([snapshot(1)]);
    f.read.mockRejectedValueOnce(new Error("source I/O failed"));
    await expect(f.index.refresh()).rejects.toThrow("source I/O failed");
    await f.index.refresh();
    expect(f.index.read(turn)).toEqual([context]);
    expect(f.read.mock.calls).toEqual([
      [0, 1],
      [0, 1],
    ]);
    const broken = fixture([snapshot(1)]);
    broken.head.mockResolvedValueOnce({ sequence: 1, recordId: randomUUID() });
    await expect(broken.index.refresh()).rejects.toThrow("changed identity");
    await broken.index.refresh();
    expect(broken.index.read(turn)).toEqual([context]);
    expect(() =>
      broken.index.read({ ...turn, metadata: { turnId: "other" } }),
    ).toThrow("another turn");
  });

  it("uses retained values only and keeps changed model/effort independent from presentation invariants", () => {
    expect(() => resolveNativeHistoryTurnContext([])).toThrow(
      "not yet retained",
    );
    expect(
      resolveNativeHistoryTurnContext([
        context,
        { ...context, model: "changed", reasoningEffort: null },
      ]),
    ).toEqual({ cwd: "/original", mode: "plan", rootTurnId: "turn" });
    for (const changed of [
      { cwd: "relative" },
      { collaborationMode: null },
      { collaborationMode: "future" },
    ])
      expect(() =>
        resolveNativeHistoryTurnContext([{ ...context, ...changed }]),
      ).toThrow();
    for (const changed of [
      { cwd: "/other" },
      { collaborationMode: "default" },
      { rootTurnId: "another-root" },
    ])
      expect(() =>
        resolveNativeHistoryTurnContext([context, { ...context, ...changed }]),
      ).toThrow("disagree");
  });
});
