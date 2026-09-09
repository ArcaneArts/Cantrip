import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reduceNativeHistory } from "../src/native-history-reducer.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";
import type { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";
type SourceRecord = Awaited<
  ReturnType<NativeHistorySourceJournal["read"]>
>[number];
const event = (
  sequence: number,
  method: string,
  params: Record<string, unknown>,
  generation = "runtime",
): SourceRecord => ({
  sequence,
  recordId: randomUUID(),
  frame: {
    kind: "notification",
    threadId: "thread",
    generation,
    sequence,
    receivedAtMs: sequence,
    method,
    params: { threadId: "thread", turnId: "turn", ...params },
  },
});
const item = (
  sequence: number,
  lifecycle: "started" | "completed",
  body: Record<string, unknown>,
  extra = {},
  generation = "runtime",
) =>
  event(
    sequence,
    `item/${lifecycle}`,
    { item: { id: "answer", type: "agentMessage", ...body }, ...extra },
    generation,
  );
const snap = (
  sequence: number,
  turns: any[],
  metadata: any[],
  barrier = sequence,
  generation = "runtime",
): SourceRecord => ({
  sequence,
  recordId: randomUUID(),
  frame: {
    kind: "snapshot",
    id: randomUUID(),
    threadId: "thread",
    generation,
    readBarrierSequence: barrier,
    completedSequence: sequence,
    receivedAtMs: sequence,
    snapshot: parseCodexNativeHistory(
      {
        thread: { id: "thread", status: { type: "idle" }, turns },
        history: {
          version: 1,
          currentTurnId: null,
          currentTurnState: "live",
          turns: metadata,
        },
      },
      "thread",
    ),
  },
});
const turn = (items: any[], id = "turn", status = "completed") => ({
  id,
  status,
  items,
  itemsView: "full",
});
const meta = (ids: string[], state = "completed", extra = {}) => ({
  turnId: "turn",
  source: "canonical",
  retention: "complete",
  items: ids.map((itemId) => ({
    itemId,
    state,
    startedAtMs: null,
    completedAtMs: null,
  })),
  usage: null,
  warnings: [],
  errors: [],
  ...extra,
});
const answer = (state: ReturnType<typeof reduceNativeHistory>) =>
  state.turns
    .find((entry) => entry.id === "turn")!
    .items.find((entry) => entry.id === "answer")!;

const cursor = (sequence: string, previousSequence: string | null = null) => ({
  epoch: "native-epoch",
  sequence,
  previousSequence,
});
function liveSnapshot(
  sequence: string,
  text: string,
  generation = "replacement",
) {
  const source = snap(
    1,
    [
      turn(
        [{ id: "answer", type: "agentMessage", text: "" }],
        "turn",
        "inProgress",
      ),
    ],
    [meta(["answer"], "started")],
    0,
    generation,
  );
  if (source.frame.kind !== "snapshot")
    throw new Error("Expected snapshot fixture.");
  source.frame.snapshot.history!.live = {
    epoch: "native-epoch",
    throughSequence: sequence,
    items: [
      {
        turnId: "turn",
        item: { id: "answer", type: "agentMessage", text },
        state: "started",
        cursor: cursor(sequence),
        startedAtMs: null,
        completedAtMs: null,
      },
    ],
  };
  return source;
}
function nativeEvent(
  source: SourceRecord,
  sequence: string,
  previous: string | null,
) {
  if (source.frame.kind !== "notification")
    throw new Error("Expected event fixture.");
  source.frame.nativeCursor = cursor(sequence, previous);
  return source;
}

describe("native history source reduction", () => {
  it("recovers a native live prefix across transport replacement without replaying included deltas", () => {
    const initial = reduceNativeHistory(
      null,
      [liveSnapshot("9007199254740993", "A")],
      "thread",
    );
    const continued = reduceNativeHistory(
      initial,
      [
        nativeEvent(
          event(
            2,
            "item/agentMessage/delta",
            { itemId: "answer", delta: "A" },
            "replacement",
          ),
          "9007199254740993",
          "9007199254740992",
        ),
        nativeEvent(
          event(
            3,
            "item/agentMessage/delta",
            { itemId: "answer", delta: "B" },
            "replacement",
          ),
          "9007199254740994",
          "9007199254740993",
        ),
        liveSnapshot("9007199254740993", "A"),
      ],
      "thread",
    );
    expect(answer(continued).body.text).toBe("AB");
    expect(answer(continued).origin.nativeCursor?.sequence).toBe(
      "9007199254740994",
    );
    const final = reduceNativeHistory(
      continued,
      [
        nativeEvent(
          item(1, "completed", { text: "AB!" }, {}, "third-transport"),
          "9007199254740995",
          "9007199254740994",
        ),
      ],
      "thread",
    );
    expect(answer(final)).toMatchObject({
      lifecycle: "completed",
      body: { text: "AB!" },
    });
    expect(answer(final).conflicts).toEqual([]);
  });
  it("keeps an out-of-order native delta as evidence until a materialized snapshot repairs its missing predecessor", () => {
    const initial = reduceNativeHistory(
      null,
      [liveSnapshot("2", "A")],
      "thread",
    );
    const gap = reduceNativeHistory(
      initial,
      [
        nativeEvent(
          event(
            2,
            "item/agentMessage/delta",
            { itemId: "answer", delta: "C" },
            "replacement",
          ),
          "4",
          "3",
        ),
      ],
      "thread",
    );
    expect(answer(gap).body.text).toBe("A");
    expect(gap.evidence.some((entry) => entry.params.delta === "C")).toBe(true);
    const repaired = reduceNativeHistory(
      gap,
      [
        liveSnapshot("4", "ABC"),
        nativeEvent(
          event(
            3,
            "item/agentMessage/delta",
            { itemId: "answer", delta: "D" },
            "replacement",
          ),
          "5",
          "4",
        ),
      ],
      "thread",
    );
    expect(answer(repaired).body.text).toBe("ABCD");
  });
  it.each([
    {
      type: "agentMessage",
      method: "item/agentMessage/delta",
      initial: { text: "" },
      update: { delta: "prefix" },
      expected: { text: "prefix" },
    },
    {
      type: "commandExecution",
      method: "item/commandExecution/outputDelta",
      initial: { aggregatedOutput: "" },
      update: { delta: "stdout" },
      expected: { aggregatedOutput: "stdout" },
    },
    {
      type: "reasoning",
      method: "item/reasoning/summaryTextDelta",
      initial: { summary: [] },
      update: { summaryIndex: 0, delta: "summary" },
      expected: { summaryParts: { "0": "summary" } },
    },
    {
      type: "fileChange",
      method: "item/fileChange/patchUpdated",
      initial: { changes: [] },
      update: { changes: [{ path: "file", diff: "+line" }] },
      expected: { changes: [{ path: "file", diff: "+line" }] },
    },
  ])(
    "keeps $type live fields when a later read retains only its start payload",
    ({ type, method, initial, update, expected }) => {
      const live = reduceNativeHistory(
        null,
        [
          item(1, "started", { type, ...initial }),
          event(2, method, { itemId: "answer", ...update }),
        ],
        "thread",
      );
      const snapshot = snap(
        3,
        [
          turn(
            [{ id: "answer", type, ...initial, extraNativeField: "retained" }],
            "turn",
            "inProgress",
          ),
        ],
        [meta(["answer"], "started")],
        2,
      );
      const read = reduceNativeHistory(live, [snapshot], "thread");
      expect(answer(read).body).toMatchObject({
        ...expected,
        extraNativeField: "retained",
      });
      expect(answer(read).origin).toEqual(answer(live).origin);
      const continued = reduceNativeHistory(
        read,
        [event(4, method, { itemId: "answer", ...update })],
        "thread",
      );
      expect(
        continued.evidence.filter((entry) => entry.method === method),
      ).toEqual([]);
      const field = type === "agentMessage" ? "text" : "aggregatedOutput";
      if (type === "agentMessage" || type === "commandExecution")
        expect(answer(continued).body[field]).toBe(
          String(update.delta) + String(update.delta),
        );
      if (type === "reasoning")
        expect(answer(continued).body.summaryParts).toEqual({
          "0": "summarysummary",
        });
      if (type === "fileChange")
        expect(answer(continued).body.changes).toEqual(update.changes);
    },
  );
  it("retains a delta with an uncertain snapshot base until an authoritative item completion", () => {
    const initial = reduceNativeHistory(
      null,
      [
        snap(
          1,
          [
            turn(
              [{ id: "answer", type: "agentMessage", text: "A" }],
              "turn",
              "inProgress",
            ),
          ],
          [meta(["answer"], "started")],
          0,
        ),
      ],
      "thread",
    );
    const next = reduceNativeHistory(
      initial,
      [event(2, "item/agentMessage/delta", { itemId: "answer", delta: "A" })],
      "thread",
    );
    expect(answer(next).body.text).toBe("A");
    expect(
      next.evidence.filter(
        (entry) => entry.method === "item/agentMessage/delta",
      ),
    ).toHaveLength(1);
    expect(next.evidence.at(-1)!.params.delta).toBe("A");
    const complete = reduceNativeHistory(
      next,
      [item(3, "completed", { text: "AB" })],
      "thread",
    );
    expect(answer(complete)).toMatchObject({
      body: { text: "AB" },
      lifecycle: "completed",
    });
  });
  it("retains exact attachment-only user vectors and identical assistant items under distinct native IDs", () => {
    const records = [
      item(1, "completed", {
        id: "input",
        type: "userMessage",
        clientId: "cantrip:original",
        content: [{ type: "image", url: "fixture://image" }],
      }),
      item(2, "completed", { text: "same" }),
      item(3, "completed", { id: "other", text: "same" }),
    ];
    const state = reduceNativeHistory(null, records, "thread");
    expect(state.turns[0]!.items).toHaveLength(3);
    expect(state.turns[0]!.items[0]!.body).toMatchObject({
      clientId: "cantrip:original",
      content: [{ type: "image", url: "fixture://image" }],
    });
    expect(answer(state).revision).toBe(1);
    expect(reduceNativeHistory(state, records, "thread")).toEqual(state);
  });

  it("combines live text and keeps a completed item through stale snapshot, late start and late delta", () => {
    const first = reduceNativeHistory(
      null,
      [
        item(1, "started", { text: "" }),
        event(2, "item/agentMessage/delta", {
          itemId: "answer",
          delta: "hello",
        }),
      ],
      "thread",
    );
    const completed = reduceNativeHistory(
      first,
      [item(3, "completed", { text: "hello world" })],
      "thread",
    );
    const revision = answer(completed).revision;
    const result = reduceNativeHistory(
      completed,
      [
        snap(
          5,
          [turn([{ id: "answer", type: "agentMessage", text: "hello" }])],
          [meta(["answer"], "started")],
          2,
        ),
        item(6, "started", { text: "" }),
        event(7, "item/agentMessage/delta", {
          itemId: "answer",
          delta: "duplicate",
        }),
      ],
      "thread",
    );
    expect(answer(result)).toMatchObject({
      body: { text: "hello world" },
      lifecycle: "completed",
      revision,
    });
  });

  it("does not append a snapshot prefix again when the read overlaps live deltas", () => {
    const records = [
      item(1, "started", { text: "" }),
      event(2, "item/agentMessage/delta", { itemId: "answer", delta: "A" }),
      event(3, "item/agentMessage/delta", { itemId: "answer", delta: "B" }),
      snap(
        4,
        [
          turn(
            [{ id: "answer", type: "agentMessage", text: "A" }],
            "turn",
            "inProgress",
          ),
        ],
        [meta(["answer"], "started")],
        1,
      ),
      event(5, "item/agentMessage/delta", { itemId: "answer", delta: "C" }),
    ];
    expect(answer(reduceNativeHistory(null, records, "thread")).body.text).toBe(
      "ABC",
    );
  });

  it("preserves late child activity independently from a terminal parent turn", () => {
    const state = reduceNativeHistory(
      null,
      [
        event(1, "turn/completed", {
          turn: { id: "turn", status: "completed", items: [] },
        }),
        item(2, "started", {
          type: "subAgentActivity",
          childThreadId: "child",
          status: "running",
        }),
      ],
      "thread",
    );
    expect(state.turns[0]!.body.status).toBe("completed");
    expect(answer(state).lifecycle).toBe("started");
    const result = reduceNativeHistory(
      state,
      [
        item(3, "completed", {
          type: "subAgentActivity",
          childThreadId: "child",
          status: "completed",
        }),
      ],
      "thread",
    );
    expect(answer(result).lifecycle).toBe("completed");
  });

  it("retains uncertain cross-runtime completions instead of silently replacing the captured tail", () => {
    const before = reduceNativeHistory(
      null,
      [item(1, "completed", { text: "late retained tail" })],
      "thread",
    );
    const result = reduceNativeHistory(
      before,
      [
        snap(
          0,
          [
            turn([
              {
                id: "answer",
                type: "agentMessage",
                text: "older persisted value",
              },
            ]),
          ],
          [meta(["answer"])],
          0,
          "replacement",
        ),
      ],
      "thread",
    );
    expect(answer(result).body.text).toBe("late retained tail");
    expect(answer(result).conflicts[0]!.body.text).toBe(
      "older persisted value",
    );
    expect(answer(result).revision).toBe(2);
    expect(
      answer(
        reduceNativeHistory(
          result,
          [
            item(
              2,
              "completed",
              { text: "measured newer" },
              { completedAtMs: 30 },
            ),
          ],
          "thread",
        ),
      ).body.text,
    ).toBe("measured newer");
  });

  it("uses measured completion order without inventing timestamps or dropping added fields", () => {
    const before = reduceNativeHistory(
      null,
      [
        item(
          1,
          "completed",
          { text: "old", extra: "keep" },
          { completedAtMs: 10 },
        ),
      ],
      "thread",
    );
    const result = reduceNativeHistory(
      before,
      [
        item(
          1,
          "completed",
          { text: "new", extra: "keep" },
          { completedAtMs: 20 },
          "replacement",
        ),
      ],
      "thread",
    );
    expect(answer(result)).toMatchObject({
      body: { text: "new", extra: "keep" },
      startedAtMs: null,
      completedAtMs: 20,
    });
    const snapshot = snap(
      2,
      [turn([{ id: "answer", type: "agentMessage", text: "new" }])],
      [meta(["answer"])],
      2,
      "replacement",
    );
    expect(
      answer(reduceNativeHistory(result, [snapshot], "thread")).body.extra,
    ).toBe("keep");
    expect(
      answer(
        reduceNativeHistory(
          result,
          [
            item(
              2,
              "completed",
              { text: "new", extra: "keep" },
              { completedAtMs: 10 },
              "replacement",
            ),
          ],
          "thread",
        ),
      ).completedAtMs,
    ).toBe(20);
  });

  it("recovers historical prefixes and revises order without deleting live-only items", () => {
    const before = reduceNativeHistory(
      null,
      [
        item(1, "completed", { text: "new" }),
        item(2, "completed", { id: "live-only", text: "latest" }),
      ],
      "thread",
    );
    const result = reduceNativeHistory(
      before,
      [
        snap(
          3,
          [
            turn([], "older"),
            turn([
              { id: "old-input", type: "userMessage", content: [] },
              { id: "answer", type: "agentMessage", text: "new" },
            ]),
          ],
          [meta(["old-input", "answer"])],
        ),
      ],
      "thread",
    );
    expect(result.turns.map((entry) => entry.id)).toEqual(["older", "turn"]);
    expect(result.turns[1]!.items.map((entry) => entry.id)).toEqual([
      "old-input",
      "answer",
      "live-only",
    ]);
    expect(answer(result).ordinal).toBe(1);
    expect(answer(result).revision).toBeGreaterThan(answer(before).revision);
  });

  it("keeps full command output, sparse reasoning summaries and file progress without presentation caps", () => {
    const output = "x".repeat(100_000);
    const state = reduceNativeHistory(
      null,
      [
        event(1, "item/commandExecution/outputDelta", {
          itemId: "cmd",
          delta: output,
        }),
        item(2, "started", {
          id: "reason",
          type: "reasoning",
          summary: ["begin "],
        }),
        event(3, "item/reasoning/summaryTextDelta", {
          itemId: "reason",
          summaryIndex: 0,
          delta: "end",
        }),
        event(4, "item/reasoning/summaryTextDelta", {
          itemId: "reason",
          summaryIndex: 1000000000,
          delta: "sparse",
        }),
        event(5, "item/fileChange/patchUpdated", {
          itemId: "file",
          changes: [{ path: "fixture.txt", diff: "+data" }],
        }),
      ],
      "thread",
    );
    expect(
      state.turns[0]!.items.find((entry) => entry.id === "cmd")!.body
        .aggregatedOutput,
    ).toBe(output);
    expect(
      state.turns[0]!.items.find((entry) => entry.id === "reason")!.body
        .summaryParts,
    ).toEqual({ "0": "begin end", "1000000000": "sparse" });
    expect(
      state.turns[0]!.items.find((entry) => entry.id === "file")!.body.changes,
    ).toEqual([{ path: "fixture.txt", diff: "+data" }]);
  });

  it("preserves unknown/scoped metadata and malformed future input without blocking later valid items", () => {
    const source = [
      event(1, "future/activity", { raw: { preserved: true } }),
      event(2, "item/agentMessage/delta", { itemId: "answer", delta: 42 }),
      item(3, "completed", { text: "works" }),
    ];
    const state = reduceNativeHistory(null, source, "thread");
    expect(state.evidence.map((entry) => entry.recordId)).toEqual(
      source.slice(0, 2).map((entry) => entry.recordId),
    );
    expect(answer(state).body.text).toBe("works");
    expect(() => reduceNativeHistory(state, [], "another-thread")).toThrow(
      "another thread",
    );
  });
});

it("retains original contexts across restart, changed settings and missing older-runtime metadata", () => {
  const original = {
    cwd: "/original",
    model: "before",
    collaborationMode: "plan",
    reasoningEffort: "high",
    rootTurnId: null,
  };
  const later = { ...original, cwd: "/later", collaborationMode: "default" };
  const first = reduceNativeHistory(
    null,
    [
      snap(
        1,
        [turn([], "turn"), turn([], "later-turn")],
        [
          meta([], "completed", { contexts: [original] }),
          meta([], "completed", { turnId: "later-turn", contexts: [later] }),
        ],
      ),
    ],
    "thread",
  );
  const replay = reduceNativeHistory(
    JSON.parse(JSON.stringify(first)),
    [
      snap(
        2,
        [turn([], "turn"), turn([], "later-turn")],
        [
          meta([], "completed", { contexts: [original, later] }),
          meta([], "completed", { turnId: "later-turn", contexts: [] }),
        ],
        2,
        "replacement",
      ),
    ],
    "thread",
  );
  expect(replay.turns[0]!.metadata!.contexts).toEqual([original, later]);
  expect(replay.turns[1]!.metadata!.contexts).toEqual([later]);
  const missing = reduceNativeHistory(
    replay,
    [snap(3, [turn([], "turn")], [meta([])], 3, "replacement")],
    "thread",
  );
  expect(missing.turns[0]!.metadata!.contexts).toEqual([original, later]);
});

describe("immutable initial turn settings", () => {
  const reduceTurnHistory = (
    threadId: string,
    previous: unknown,
    records: SourceRecord[],
  ) => reduceNativeHistory(previous, records, threadId);
  const initialSettings = {
    model: "captured-model",
    modelProvider: "captured-provider",
    reasoningEffort: null,
    effectiveReasoningEffort: "high",
    serviceTier: "default",
    effectiveServiceTier: null,
    collaborationMode: "plan",
  };
  it("retains an exact live capture through completion, old snapshots and runtime replacement", () => {
    let state = reduceTurnHistory("thread", null, [
      event(1, "turn/started", {
        turn: turn([], "turn", "inProgress"),
        initialSettings,
      }),
    ]);
    expect(state.turns[0]!.metadata?.initialSettings).toEqual(initialSettings);
    state = reduceTurnHistory("thread", state, [
      event(2, "thread/settings/updated", {
        threadSettings: { ...initialSettings, model: "later-model" },
      }),
      event(3, "turn/completed", { turn: turn([]) }),
      snap(
        4,
        [turn([]), turn([], "unrelated")],
        [meta([]), meta([], "completed", { turnId: "unrelated" })],
        4,
        "replacement",
      ),
    ]);
    expect(state.turns[0]!.metadata?.initialSettings).toEqual(initialSettings);
    expect(state.turns[1]!.metadata).not.toHaveProperty("initialSettings");
  });
  it("learns retained snapshots and never chooses between conflicting immutable captures", () => {
    const different = { ...initialSettings, model: "different-model" };
    let state = reduceTurnHistory("thread", null, [
      snap(1, [turn([])], [meta([], "completed", { initialSettings })]),
    ]);
    expect(state.turns[0]!.metadata?.initialSettings).toEqual(initialSettings);
    state = reduceTurnHistory("thread", state, [
      event(2, "turn/started", { turn: turn([]), initialSettings: different }),
    ]);
    expect(state.turns[0]!.metadata).not.toHaveProperty("initialSettings");
    expect(state.turns[0]!.conflicts).toContainEqual({ initialSettings });
    expect(state.turns[0]!.conflicts).toContainEqual({
      initialSettings: different,
    });
    state = reduceTurnHistory("thread", JSON.parse(JSON.stringify(state)), [
      snap(
        3,
        [turn([])],
        [meta([], "completed", { initialSettings })],
        3,
        "replacement",
      ),
    ]);
    expect(state.turns[0]!.metadata).not.toHaveProperty("initialSettings");
    expect(state.turns[0]!.conflicts).toHaveLength(2);
  });
  it("clears live attribution when native retention reports conflicting starts and never revives it from omission", () => {
    let state = reduceTurnHistory("thread", null, [
      event(1, "turn/started", {
        turn: turn([], "turn", "inProgress"),
        initialSettings,
      }),
    ]);
    state = reduceTurnHistory("thread", state, [
      snap(
        2,
        [turn([])],
        [meta([], "completed", { initialSettingsConflict: true })],
      ),
    ]);
    expect(state.turns[0]!.metadata).not.toHaveProperty("initialSettings");
    expect(state.turns[0]!.conflicts).toContainEqual({
      initialSettingsConflict: true,
    });
    state = reduceTurnHistory("thread", JSON.parse(JSON.stringify(state)), [
      snap(3, [turn([])], [meta([])], 3, "replacement"),
      event(
        4,
        "turn/started",
        { turn: turn([]), initialSettings },
        "replacement",
      ),
    ]);
    expect(state.turns[0]!.metadata).not.toHaveProperty("initialSettings");
    expect(state.turns[0]!.conflicts).toContainEqual({ initialSettings });
  });
  it("does not invent settings for malformed live input or schema-accept invalid retained captures", () => {
    const state = reduceTurnHistory("thread", null, [
      event(1, "turn/started", {
        turn: turn([]),
        initialSettings: { model: "incomplete" },
      }),
    ]);
    expect(state.turns[0]!.metadata).toBeNull();
    expect(() =>
      snap(
        2,
        [turn([])],
        [meta([], "completed", { initialSettings: { model: "incomplete" } })],
      ),
    ).toThrow();
  });
});
