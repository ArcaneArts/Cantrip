import assert from "node:assert/strict";
import { reconcileNativeHistoryUsage } from "../../packages/protocol/dist/index.js";

export async function runHistoryUsageCases({ call, unchanged }) {
  const counts = (n = 1) => ({
    totalTokens: n,
    inputTokens: n,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  });
  const response = (id, n = 1) => ({ responseId: id, usage: counts(n) });
  const evidence = (responses = [], complete = false, extra = {}) => ({
    version: 1,
    responses,
    complete,
    conflictingResponseIds: [],
    ...extra,
  });
  const capture = {
    threadId: "thread",
    turnId: "turn",
    isRoot: true,
    reasoningEffort: null,
    selection: { status: "unavailable" },
  };
  const cases = [
    ["empty partial", undefined, evidence()],
    ["empty complete", undefined, evidence([], true)],
    ["one measured response", undefined, evidence([response("one", 4)], true)],
    [
      "identical duplicate counts once",
      evidence([response("one", 4)]),
      evidence([response("one", 4)], true),
    ],
    [
      "new partial cannot retain an incomplete old complete set",
      evidence([response("one", 4)], true),
      evidence([response("two", 2)]),
    ],
    [
      "complete set owns both responses",
      evidence([response("one", 4)]),
      evidence([response("two", 2), response("one", 4)], true),
    ],
    [
      "prior complete set survives partial replay",
      evidence([response("one", 4), response("two", 2)], true),
      evidence([response("one", 4)]),
    ],
    [
      "conflicting response is excluded",
      evidence([response("one", 4)], true),
      evidence([response("one", 5), response("two", 2)], true),
    ],
    [
      "retained conflict remains explicit",
      evidence([response("one", 4)], false, {
        conflictingResponseIds: ["one"],
      }),
      evidence([response("one", 4)], true),
    ],
    [
      "incoming conflict can precede its response",
      undefined,
      evidence([response("two", 2)], true, { conflictingResponseIds: ["one"] }),
    ],
    [
      "overflow retains evidence without a false subtotal",
      undefined,
      evidence(
        [response("huge", Number.MAX_SAFE_INTEGER), response("one")],
        true,
      ),
    ],
    [
      "native response ordering uses actual locale semantics",
      undefined,
      evidence(
        ["r10", "r2", "a", "A", "😀", "\ue000", "\ud800", "\udfff"].map((id) =>
          response(id),
        ),
        true,
      ),
    ],
    [
      "retain native model capture",
      evidence([response("one")], false, { modelAttribution: capture }),
      evidence([response("two")]),
    ],
    [
      "capture is insensitive to input property order",
      evidence([], false, { modelAttribution: capture }),
      evidence([], true, {
        modelAttribution: {
          selection: { status: "unavailable" },
          reasoningEffort: null,
          isRoot: true,
          turnId: "turn",
          threadId: "thread",
        },
      }),
    ],
  ];
  for (const field of Object.keys(counts())) {
    const changed = response("one");
    changed.usage[field] += 1;
    cases.push([
      "conflict in " + field,
      evidence([response("one")]),
      evidence([changed], true),
    ]);
  }
  await unchanged(
    "usage reconciliation has no durable side effects",
    async () => {
      for (const [name, previous, input] of cases) {
        const outputs = await call(name, {
          op: "native-history-reconcile-usage",
          previous,
          input,
        });
        for (const output of outputs)
          assert.deepEqual(
            output,
            reconcileNativeHistoryUsage(previous, input),
          );
      }
      await call(
        "conflicting capture cannot be replaced",
        {
          op: "native-history-reconcile-usage",
          previous: evidence([], true, { modelAttribution: capture }),
          input: evidence([], true, {
            modelAttribution: { ...capture, reasoningEffort: "low" },
          }),
        },
        {
          message:
            "Native usage model attribution conflicts with retained evidence.",
        },
      );
    },
  );
}
