import { describe, expect, it } from "vitest";
import {
  nativeTurnTokenPerformance,
  turnTokenRates,
  formatTokenRate,
  mergeTurnTokenPerformance,
} from "./native-turn-token-performance";

const counts = (outputTokens: number) => ({
  totalTokens: 10_000 + outputTokens,
  inputTokens: 10_000,
  cachedInputTokens: 5_000,
  cacheWriteInputTokens: 0,
  outputTokens,
  reasoningOutputTokens: outputTokens / 2,
});
const model = (
  id: string,
  type: string,
  start: number | null,
  end: number | null,
) => ({
  id,
  body: { type },
  startedAtMs: start,
  completedAtMs: end,
  conflicts: [],
});
const input = () => ({
  threadId: "root",
  turnId: "turn",
  source: {
    version: 2,
    reducedTurn: {
      id: "turn",
      body: { id: "turn", startedAt: 1, completedAt: 21, durationMs: 20_000 },
      items: [
        model("reason", "reasoning", 1_000, 5_000),
        model("text", "agentMessage", 5_000, 7_000),
        model("command", "commandExecution", 7_000, 17_000),
        model("final", "agentMessage", 17_000, 21_000),
      ],
      metadata: {
        retention: "complete",
        usage: {
          responses: [
            { threadId: "root", responseId: "one", usage: counts(600) },
            { threadId: "root", responseId: "two", usage: counts(400) },
            {
              threadId: "child",
              responseId: "child-response",
              usage: counts(9_000),
            },
          ],
          conflictingResponseIds: [],
        },
      },
    },
  },
});

describe("turn token performance", () => {
  it("uses available timing across replacement archives without hiding the real rate", () => {
    const complete = nativeTurnTokenPerformance(input())!;
    expect(
      mergeTurnTokenPerformance([
        { ...complete, outputDurationMs: null },
        complete,
      ]),
    ).toEqual(complete);
    expect(
      mergeTurnTokenPerformance([
        complete,
        { ...complete, outputDurationMs: 5000 },
      ]),
    ).toEqual({ ...complete, outputDurationMs: null });
    expect(
      mergeTurnTokenPerformance([complete, { ...complete, outputTokens: 500 }]),
    ).toBeUndefined();
  });
  it("reports half the active-output speed when commands occupy half the turn", () => {
    const performance = nativeTurnTokenPerformance(input())!;
    expect(performance).toEqual({
      totalTokens: 21_000,
      outputTokens: 1_000,
      durationMs: 20_000,
      outputDurationMs: 10_000,
    });
    expect(turnTokenRates(performance, performance.durationMs)).toEqual({
      output: 100,
      real: 50,
    });
    expect(formatTokenRate(50)).toBe("50 tok/s");
  });

  it("deduplicates responses and unions overlapping model intervals", () => {
    const source = input();
    const turn = source.source.reducedTurn;
    turn.metadata.usage.responses.push(turn.metadata.usage.responses[0]!);
    turn.items.push(model("overlap", "reasoning", 2_000, 6_000));
    expect(nativeTurnTokenPerformance(source)).toMatchObject({
      outputTokens: 1_000,
      outputDurationMs: 10_000,
    });
  });

  it("keeps the whole-turn rate when model timing is missing", () => {
    const source = input();
    source.source.reducedTurn.items[0]!.startedAtMs = null;
    const performance = nativeTurnTokenPerformance(source)!;
    expect(turnTokenRates(performance, performance.durationMs)).toEqual({
      output: null,
      real: 50,
    });
  });

  it.each(["partial", "conflicting", "duplicate-conflict", "wrong-turn"])(
    "does not invent complete totals from %s evidence",
    (kind) => {
      const source = input();
      const turn = source.source.reducedTurn;
      if (kind === "partial") turn.metadata.retention = "partial";
      if (kind === "conflicting")
        (turn.metadata.usage.conflictingResponseIds as string[]).push("one");
      if (kind === "duplicate-conflict")
        turn.metadata.usage.responses.push({
          threadId: "root",
          responseId: "one",
          usage: counts(800),
        });
      if (kind === "wrong-turn") turn.body.id = "other";
      expect(nativeTurnTokenPerformance(source)).toBeUndefined();
    },
  );

  it("can recover legacy item timestamps and response totals", () => {
    const original = input();
    const reduced = original.source.reducedTurn;
    const source = {
      version: 1,
      nativeTurn: {
        ...reduced.body,
        items: reduced.items.map((item) => ({ id: item.id, ...item.body })),
      },
      history: {
        ...reduced.metadata,
        items: reduced.items.map((item) => ({
          itemId: item.id,
          startedAtMs: item.startedAtMs,
          completedAtMs: item.completedAtMs,
        })),
      },
    };
    expect(nativeTurnTokenPerformance({ ...original, source })).toMatchObject({
      outputTokens: 1_000,
      outputDurationMs: 10_000,
    });
  });

  it("uses authenticated per-turn totals without depending on legacy context counters", () => {
    const source = input();
    source.source.reducedTurn.metadata.retention = "unavailable";
    const usage = {
      version: 1 as const,
      responses: [{ responseId: "one", usage: counts(200) }],
      complete: true,
      conflictingResponseIds: [],
    };
    expect(nativeTurnTokenPerformance({ ...source, usage })?.outputTokens).toBe(
      200,
    );
  });

  it("does not divide by zero, fabricate old-history rates, or add reasoning twice", () => {
    expect(
      nativeTurnTokenPerformance({
        source: {},
        threadId: "root",
        turnId: "turn",
      }),
    ).toBeUndefined();
    const performance = nativeTurnTokenPerformance(input())!;
    expect(turnTokenRates(performance, 0).real).toBeNull();
    expect(turnTokenRates(performance, 40_000).real).toBe(25);
    expect(
      turnTokenRates({ ...performance, outputTokens: 0 }, 20_000).real,
    ).toBe(0);
    expect(formatTokenRate(Infinity)).toBe("—");
    expect(formatTokenRate(0.01)).toBe("<0.1 tok/s");
  });
});
