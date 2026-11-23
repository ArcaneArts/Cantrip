import { describe, expect, it } from "vitest";
import { reconcileNativeHistoryUsage } from "@cantrip/protocol";
import { nativeHistoryUsageForTurn } from "../src/native-history-usage.js";
const usage = {
  inputTokens: 3,
  outputTokens: 5,
  totalTokens: 8,
  cachedInputTokens: 1,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 2,
};
const response = (responseId: string, threadId = "thread") => ({
  responseId,
  threadId,
  usage,
});
const derive = (responses: ReturnType<typeof response>[], complete = true) =>
  nativeHistoryUsageForTurn("thread", "turn", {
    retention: complete ? "complete" : "partial",
    usage: { responses, conflictingResponseIds: [] },
  })!;
describe("retained native response analytics", () => {
  it("deduplicates response identities and excludes copied usage from other physical threads", () => {
    const evidence = derive([
      response("a"),
      response("a"),
      response("a", "source-thread"),
      response("b"),
    ]);
    expect(evidence.responses.map((entry) => entry.responseId)).toEqual([
      "a",
      "b",
    ]);
    expect(
      reconcileNativeHistoryUsage(undefined, evidence).totals,
    ).toMatchObject({ inputTokens: 6, outputTokens: 10 });
  });
  it("does not regress a complete response set when an older subset is replayed", () => {
    const complete = derive([response("a"), response("b")]);
    expect(
      reconcileNativeHistoryUsage(complete, derive([response("a")], false))
        .evidence,
    ).toEqual(complete);
    expect(
      reconcileNativeHistoryUsage(complete, derive([response("c")], false))
        .evidence.complete,
    ).toBe(false);
  });
  it("keeps unknown retention distinct from an observed zero-response turn", () => {
    expect(derive([response("copied", "ancestor-thread")])).toBeUndefined();
    expect(
      nativeHistoryUsageForTurn("thread", "turn", {
        retention: "unavailable",
        usage: null,
      }),
    ).toBeUndefined();
    expect(
      nativeHistoryUsageForTurn("thread", "turn", {
        retention: "complete",
        usage: null,
      }),
    ).toMatchObject({ responses: [], complete: true });
    expect(
      nativeHistoryUsageForTurn("thread", "turn", {
        retention: "partial",
        usage: { last: usage },
      }),
    ).toBeUndefined();
  });
  it("retains conflicting response IDs without summing disputed values", () => {
    const first = derive([response("a"), response("b")]);
    const later = derive([
      { ...response("a"), usage: { ...usage, inputTokens: 99 } },
    ]);
    const result = reconcileNativeHistoryUsage(first, later);
    expect(result.evidence).toMatchObject({
      complete: false,
      conflictingResponseIds: ["a"],
    });
    expect(result.totals).toEqual(usage);
  });
  it("does not publish an imprecise overflowing aggregate", () => {
    const evidence = derive([
      {
        ...response("a"),
        usage: { ...usage, totalTokens: Number.MAX_SAFE_INTEGER },
      },
      response("b"),
    ]);
    expect(reconcileNativeHistoryUsage(undefined, evidence)).toMatchObject({
      evidence: { complete: false },
      totals: null,
    });
  });
});
