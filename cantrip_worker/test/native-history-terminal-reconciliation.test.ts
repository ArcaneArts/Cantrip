import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reduceNativeHistory } from "../src/native-history-reducer.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";
import type { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";

type Record = Awaited<ReturnType<NativeHistorySourceJournal["read"]>>[number];
const body = (status: string, completedAt: number | null = null) => ({
  id: "turn",
  status,
  items: [],
  startedAt: 10,
  completedAt,
  durationMs: completedAt === null ? null : 50,
});
const snapshot = (
  sequence: number,
  status: string,
  currentTurnId: string | null = null,
  completedAt: number | null = null,
): Record => ({
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
        thread: {
          id: "thread",
          status: { type: "idle" },
          turns: [body(status, completedAt)],
        },
        history: {
          version: 1,
          currentTurnId,
          currentTurnState: "live",
          turns: [],
        },
      },
      "thread",
    ),
  },
});
const notification = (sequence: number, status: string): Record => ({
  sequence,
  recordId: randomUUID(),
  frame: {
    kind: "notification",
    threadId: "thread",
    generation: "runtime",
    sequence,
    receivedAtMs: sequence,
    method: status === "inProgress" ? "turn/started" : "turn/completed",
    params: {
      threadId: "thread",
      turn: body(status, status === "inProgress" ? null : 11),
    },
  },
});
const reduce = (records: Record[], previous: unknown = null) =>
  reduceNativeHistory(previous, records, "thread");

describe("native terminal evidence reconciliation", () => {
  it("clears stale snapshot error details when actual completion explicitly reports no error", () => {
    const failed = snapshot(22, "failed");
    if (failed.frame.kind !== "snapshot") throw new Error("Expected snapshot");
    failed.frame.snapshot.thread.turns[0]!.error = {
      message: "stale snapshot error",
    };
    const completed = notification(31, "completed");
    if (completed.frame.kind !== "notification")
      throw new Error("Expected notification");
    (completed.frame.params.turn as { error?: null }).error = null;
    const result = reduce([failed, completed]);
    expect(result.turns[0]!.body).toMatchObject({
      status: "completed",
      error: null,
    });
  });
  it("does not turn a snapshot's exact live current turn into an interruption before its start notification", () => {
    const early = reduce([snapshot(22, "interrupted", "turn")]);
    expect(early.turns[0]!.body.status).toBe("inProgress");
    const started = reduce(
      [notification(24, "inProgress")],
      JSON.parse(JSON.stringify(early)),
    );
    expect(started.turns[0]!.body.status).toBe("inProgress");
    const completed = reduce(
      [notification(31, "completed"), snapshot(31, "completed", null, 11)],
      started,
    );
    expect(completed.turns[0]!.body.status).toBe("completed");
    expect(completed.turns[0]!.body.completedAt).toBe(11);
  });
  it.each(["completed", "failed", "interrupted"])(
    "lets an actual %s completion correct conflicting snapshot-only evidence",
    (status) => {
      const original = status === "interrupted" ? "completed" : "interrupted";
      const observed = reduce([
        snapshot(22, original),
        notification(24, "inProgress"),
      ]);
      const result = reduce(
        [notification(31, status)],
        JSON.parse(JSON.stringify(observed)),
      );
      expect(result.turns[0]!.body.status).toBe(status);
      expect(result.turns[0]!.conflicts).toContainEqual(
        expect.objectContaining({ status: original }),
      );
    },
  );
  it("never reopens or relabels an actual Stop from late start and conflicting snapshots or completion notifications", () => {
    const stopped = reduce([notification(20, "interrupted")]);
    const result = reduce(
      [
        notification(21, "inProgress"),
        snapshot(22, "interrupted", "turn"),
        snapshot(23, "completed", null, 11),
        notification(24, "completed"),
      ],
      JSON.parse(JSON.stringify(stopped)),
    );
    expect(result.turns[0]!.body.status).toBe("interrupted");
    expect(result.turns[0]!.body.completedAt).toBe(11);
  });
  it("keeps an unloaded or different-current-turn interruption terminal", () => {
    for (const currentTurnId of [null, "different"]) {
      const result = reduce([
        snapshot(22, "interrupted", currentTurnId),
        notification(24, "inProgress"),
      ]);
      expect(result.turns[0]!.body.status).toBe("interrupted");
    }
  });
  it("does not treat an interruption with a retained completion timestamp as provisional", () => {
    expect(
      reduce([snapshot(22, "interrupted", "turn", 11)]).turns[0]!.body.status,
    ).toBe("interrupted");
  });
  it("does not rewrite older snapshot-only states until stronger completion evidence arrives", () => {
    const original = reduce([snapshot(22, "interrupted")]);
    expect(
      reduce([snapshot(24, "completed")], original).turns[0]!.body.status,
    ).toBe("interrupted");
    expect(
      reduce([snapshot(24, "completed", null, 11)], original).turns[0]!.body
        .status,
    ).toBe("completed");
  });
});
