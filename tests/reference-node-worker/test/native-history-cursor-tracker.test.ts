import { describe, expect, it } from "vitest";
import { NativeHistoryCursorTracker } from "../src/native-history-cursor-tracker.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";
import type { NativeHistoryNotification } from "../src/codex/native-history-observation.js";

function event(
  sequence: number,
  nativeSequence: string,
  previousSequence: string | null,
  method = "item/agentMessage/delta",
  epoch = "epoch",
): NativeHistoryNotification {
  return {
    kind: "notification",
    generation: "transport",
    sequence,
    threadId: "thread",
    receivedAtMs: 1,
    method,
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "answer",
      item: { id: "answer", type: "agentMessage", text: "complete" },
      delta: "text",
    },
    nativeCursor: { epoch, sequence: nativeSequence, previousSequence },
  };
}
function observation(
  readBarrierSequence: number,
  epoch = "epoch",
  itemSequence?: string,
) {
  return {
    kind: "snapshot" as const,
    id: "snapshot",
    generation: "transport",
    threadId: "thread",
    readBarrierSequence,
    completedSequence: 100,
    receivedAtMs: 2,
    snapshot: parseCodexNativeHistory(
      {
        thread: { id: "thread", status: { type: "active" }, turns: [] },
        history: {
          version: 1,
          currentTurnId: "turn",
          currentTurnState: "live",
          turns: [],
          live: {
            epoch,
            throughSequence: "100",
            items: itemSequence
              ? [
                  {
                    turnId: "turn",
                    item: { id: "answer", type: "agentMessage", text: "text" },
                    state: "started",
                    startedAtMs: null,
                    completedAtMs: null,
                    cursor: {
                      epoch,
                      sequence: itemSequence,
                      previousSequence: null,
                    },
                  },
                ]
              : [],
          },
        },
      },
      "thread",
    ),
  };
}

describe("native item cursor recovery", () => {
  it("requires the newest missing item's evidence, not a thread watermark or partial prefix", () => {
    const tracker = new NativeHistoryCursorTracker();
    expect(tracker.notification(event(1, "1", null, "item/started"))).toBe(
      false,
    );
    expect(tracker.notification(event(2, "3", "2"))).toBe(true);
    expect(tracker.notification(event(3, "5", "4"))).toBe(true);
    expect(tracker.notification(event(4, "3", "2"))).toBe(true);
    expect(tracker.snapshot(observation(4))).toBe(true);
    expect(tracker.snapshot(observation(4, "epoch", "3"))).toBe(true);
    expect(tracker.snapshot(observation(4, "epoch", "5"))).toBe(false);
    // A delayed older read must not undo the repaired base.
    expect(tracker.snapshot(observation(4, "epoch", "1"))).toBe(false);
    expect(tracker.notification(event(5, "6", "5"))).toBe(false);
  });

  it("settles a pending gap with a later complete item without another matching snapshot", () => {
    const tracker = new NativeHistoryCursorTracker();
    expect(tracker.notification(event(1, "3", "2"))).toBe(true);
    expect(tracker.notification(event(2, "4", "3", "item/completed"))).toBe(
      false,
    );
    expect(tracker.snapshot(observation(2))).toBe(false);
    expect(tracker.notification(event(3, "3", "2"))).toBe(false);
  });

  it("does not confuse an overlapping old-epoch read with an actual cache replacement", () => {
    const tracker = new NativeHistoryCursorTracker();
    expect(tracker.notification(event(2, "3", "2", undefined, "new"))).toBe(
      true,
    );
    // This read started before the new epoch's event; a late response cannot
    // stop repair for the new epoch even with a larger snapshot completion bound.
    expect(tracker.snapshot(observation(1, "old"))).toBe(true);
    expect(tracker.snapshot(observation(2, "new", "3"))).toBe(false);
    expect(tracker.notification(event(3, "5", "4", undefined, "new"))).toBe(
      true,
    );
    // A fresh read of a replaced cache stops polling for inaccessible old data.
    // It does not consume the encrypted source evidence or claim its recovery.
    expect(tracker.snapshot(observation(3, "replacement"))).toBe(false);
  });
});
