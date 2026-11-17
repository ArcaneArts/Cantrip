// Run the unchanged Node tests against both real reducers. Each native call is
// a fresh owned process, so every transition crosses a serialization boundary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { afterAll, vi } from "vitest";

let comparisons = 0;
vi.mock(
  "../../cantrip_worker/src/native-history-reducer.js",
  async (importOriginal) => {
    const source =
      await importOriginal<
        typeof import("../../cantrip_worker/src/native-history-reducer.js")
      >();
    return {
      ...source,
      reduceNativeHistory: (
        ...args: Parameters<typeof source.reduceNativeHistory>
      ) => {
        const [previous, records, threadId] = args;
        let expected: { ok: boolean; value?: unknown; error?: string };
        try {
          expected = { ok: true, value: source.reduceNativeHistory(...args) };
        } catch (error) {
          expected = { ok: false, error: (error as Error).message };
        }
        const actual = JSON.parse(
          execFileSync(process.env.CANTRIP_NATIVE_HISTORY_FIXTURE!, [], {
            input:
              JSON.stringify(
                { op: "reduce", previous, records, threadId },
                (_key, value) =>
                  Object.is(value, -0) ? JSON.rawJSON("-0") : value,
              ) + "\n",
            encoding: "utf8",
            env: { ...process.env, PATH: "/usr/bin:/bin" },
            maxBuffer: 16 * 1024 * 1024,
            timeout: 30_000,
          }),
        );
        assert.deepEqual(
          actual,
          expected,
          "Node/native full reducer state and revisions",
        );
        if (actual.ok) {
          // Projection hashes depend on JSON property order as well as values.
          assert.equal(
            JSON.stringify(actual.value),
            JSON.stringify(expected.value),
            "exact reducer JSON bytes",
          );
        }
        comparisons++;
        if (!actual.ok) throw new Error(actual.error);
        return actual.value;
      },
    };
  },
);
afterAll(() => {
  assert.ok(
    comparisons > 0,
    "The native differential reducer must actually execute",
  );
  const report = JSON.stringify({
    nativeReducerComparisons: comparisons,
    freshNativeProcessPerTransition: true,
  });
  if (process.env.CANTRIP_HISTORY_REDUCER_REPORT)
    appendFileSync(process.env.CANTRIP_HISTORY_REDUCER_REPORT, report + "\n");
  console.log(report);
});
