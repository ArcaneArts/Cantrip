import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reduceNativeHistory } from "../src/native-history-reducer.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";

type Records = Parameters<typeof reduceNativeHistory>[1];
const event = (
  sequence: number,
  method: string,
  params: Record<string, unknown>,
): Records[number] => ({
  sequence,
  recordId: randomUUID(),
  frame: {
    kind: "notification",
    generation: "runtime",
    sequence,
    threadId: "thread",
    receivedAtMs: sequence,
    method,
    params: { turnId: "turn", ...params },
  },
});
const read = (
  sequence: number,
  status: string,
  completedAt: number | null,
  current = "live",
): Records[number] => ({
  sequence,
  recordId: randomUUID(),
  frame: {
    kind: "snapshot",
    id: randomUUID(),
    generation: "runtime",
    threadId: "thread",
    readBarrierSequence: sequence,
    completedSequence: sequence,
    receivedAtMs: sequence,
    snapshot: parseCodexNativeHistory(
      {
        thread: {
          id: "thread",
          status: { type: "idle" },
          turns: [{ id: "turn", status, completedAt, error: null, items: [] }],
        },
        history: {
          version: 1,
          currentTurnId: "turn",
          currentTurnState: current,
          turns: [],
        },
      },
      "thread",
    ),
  },
});

describe("native history reduction boundaries", () => {
  it("reports actual string coercion failures without losing the prior state", () => {
    expect(() =>
      reduceNativeHistory(
        null,
        [
          event(1, "turn/completed", {
            turn: { id: "turn", status: { toString: 0 } },
          }),
        ],
        "thread",
      ),
    ).toThrow("Cannot convert object to primitive value");
    const state = reduceNativeHistory(
      null,
      [
        event(1, "item/started", {
          item: {
            id: "reasoning",
            type: "reasoning",
            summaryParts: { "0": { toString: 0 } },
          },
        }),
      ],
      "thread",
    );
    const before = JSON.stringify(state);
    expect(() =>
      reduceNativeHistory(
        state,
        [
          event(2, "item/reasoning/summaryTextDelta", {
            itemId: "reasoning",
            summaryIndex: 0,
            delta: "text",
          }),
        ],
        "thread",
      ),
    ).toThrow("Cannot convert object to primitive value");
    expect(JSON.stringify(state)).toBe(before);
  });
  it("revises an item when negative zero is replaced by positive zero", () => {
    const state = reduceNativeHistory(
      null,
      [
        event(1, "item/completed", {
          item: { id: "answer", type: "agentMessage", value: -0 },
        }),
        event(2, "item/completed", {
          item: { id: "answer", type: "agentMessage", value: 0 },
        }),
      ],
      "thread",
    );
    expect(state.turns[0]!.items[0]!.revision).toBe(2);
  });
  it("keeps provisional interruption separate from actual completion and terminal corrections", () => {
    const provisional = reduceNativeHistory(
      null,
      [read(1, "interrupted", null)],
      "thread",
    );
    expect(provisional.turns[0]!.body.status).toBe("inProgress");
    expect(provisional.turns[0]!.conflicts).toHaveLength(1);
    const completed = reduceNativeHistory(
      provisional,
      [
        event(2, "turn/completed", {
          turn: {
            id: "turn",
            status: "completed",
            completedAt: 42,
            durationMs: 7,
            error: null,
          },
        }),
      ],
      "thread",
    );
    const lateRead = reduceNativeHistory(
      completed,
      [read(3, "interrupted", null, "notLoaded")],
      "thread",
    );
    expect(lateRead.turns[0]!.body).toMatchObject({
      status: "completed",
      completedAt: 42,
      durationMs: 7,
      error: null,
    });
    expect(lateRead.turns[0]!.terminalNotification).toBe("completed");
    const conflict = reduceNativeHistory(
      lateRead,
      [
        event(4, "turn/completed", {
          turn: { id: "turn", status: "failed", error: "late failure" },
        }),
      ],
      "thread",
    );
    expect(conflict.turns[0]!.body.status).toBe("completed");
    expect(
      conflict.turns[0]!.conflicts.some((v) => v.status === "failed"),
    ).toBe(true);
  });

  it("preserves unknown and malformed delta evidence without suppressing successors", () => {
    const state = reduceNativeHistory(
      null,
      [
        event(1, "item/reasoning/summaryTextDelta", {
          itemId: "reasoning",
          summaryIndex: 9007199254740991,
          delta: "sparse \ud800",
        }),
        event(2, "item/reasoning/summaryPartAdded", {
          itemId: "reasoning",
          summaryIndex: 0,
        }),
        event(3, "item/reasoning/summaryTextDelta", {
          itemId: "reasoning",
          summaryIndex: -1,
          delta: "invalid",
        }),
        event(4, "item/reasoning/summaryUnknown", {
          itemId: "reasoning",
          summaryIndex: 2,
        }),
        event(5, "item/commandExecution/outputDelta", {
          itemId: "tool",
          delta: "stdout\n\u2028",
        }),
        event(6, "item/fileChange/patchUpdated", {
          itemId: "file",
          changes: "invalid",
        }),
        event(
          7,
          "future/retained",
          JSON.parse(
            '{"nested":{"__proto__":{"kept":true},"constructor":"own","prototype":1}}',
          ),
        ),
      ],
      "thread",
    );
    expect(state.turns[0]!.items[0]!.body.summaryParts).toEqual({
      "0": "",
      "9007199254740991": "sparse \ud800",
    });
    expect(state.evidence.map((v) => v.method)).toEqual([
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryUnknown",
      "item/fileChange/patchUpdated",
      "future/retained",
    ]);
    expect(state.turns[0]!.items[1]!.body.aggregatedOutput).toBe(
      "stdout\n\u2028",
    );
  });

  it("deduplicates replayed source identities and rejects foreign state without mutation", () => {
    const records = [
      event(1, "item/completed", {
        item: { id: "answer", type: "agentMessage", text: "a" },
      }),
      read(2, "completed", 10),
    ];
    const state = reduceNativeHistory(null, records, "thread"),
      before = JSON.stringify(state);
    expect(reduceNativeHistory(state, records, "thread")).toEqual(state);
    expect(JSON.stringify(state)).toBe(before);
    expect(() => reduceNativeHistory(state, [], "another")).toThrow(
      "state belongs to another thread",
    );
    const foreign = structuredClone(records[0]!);
    foreign.frame.threadId = "other";
    expect(() => reduceNativeHistory(state, [foreign], "thread")).toThrow(
      "source belongs to another thread",
    );
  });

  it("compares JSON objects by keys and preserves malformed-but-retained terminal evidence", () => {
    const first = event(1, "item/completed", {
      item: { id: "answer", type: "agentMessage", data: { a: 1, b: 2 } },
    });
    const second = event(2, "item/completed", {
      item: { type: "agentMessage", data: { b: 2, a: 1 }, id: "answer" },
    });
    const state = reduceNativeHistory(null, [first, second], "thread");
    expect(state.turns[0]!.items[0]!.revision).toBe(1);
    const malformed = reduceNativeHistory(
      null,
      [
        event(1, "turn/started", {
          turn: { id: "turn", status: ["completed"] },
        }),
        event(2, "turn/started", {
          turn: { id: "turn", status: ["completed"] },
        }),
      ],
      "thread",
    );
    expect(malformed.turns[0]!.conflicts).toHaveLength(1);
  });

  it("learns settings over retained null without manufacturing an immutable conflict", () => {
    const initial = reduceNativeHistory(
      null,
      [
        event(1, "turn/started", {
          turn: { id: "turn", status: "inProgress" },
        }),
      ],
      "thread",
    );
    initial.turns[0]!.metadata = { initialSettings: null };
    const settings = {
      model: "native",
      modelProvider: "provider",
      reasoningEffort: null,
      effectiveReasoningEffort: null,
      serviceTier: null,
      effectiveServiceTier: null,
      collaborationMode: "default",
    };
    const state = reduceNativeHistory(
      initial,
      [
        event(2, "turn/started", {
          turn: { id: "turn", status: "inProgress" },
          initialSettings: settings,
        }),
      ],
      "thread",
    );
    expect(state.turns[0]!.metadata!.initialSettings).toEqual(settings);
    expect(state.turns[0]!.conflicts).toEqual([]);
  });
});
