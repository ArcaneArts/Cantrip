// Existing integration tests consume actual native-restored state after a full
// comparison with the unchanged Node restore helper. No production fallback.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { afterAll, vi } from "vitest";
let comparisons = 0;
vi.mock(
  "../../cantrip_worker/src/native-history-projector-bootstrap.js",
  async (importOriginal) => {
    const source =
      await importOriginal<
        typeof import("../../cantrip_worker/src/native-history-projector-bootstrap.js")
      >();
    return {
      ...source,
      restoreNativeHistoryProjectorState: (
        recovery: Parameters<
          typeof source.restoreNativeHistoryProjectorState
        >[0],
      ) => {
        const expected = source.restoreNativeHistoryProjectorState(recovery);
        const actual = JSON.parse(
          execFileSync(process.env.CANTRIP_NATIVE_HISTORY_FIXTURE!, [], {
            input: JSON.stringify({ op: "projector.restore", recovery }) + "\n",
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 30000,
            env: { ...process.env, PATH: "/usr/bin:/bin" },
          }),
        );
        assert.equal(actual.ok, true, actual.error);
        assert.deepEqual(
          actual.value,
          expected,
          "Native canonical recovery state",
        );
        assert.ok(
          JSON.stringify(actual.value) === JSON.stringify(expected),
          "Exact restored JSON order",
        );
        comparisons++;
        return actual.value;
      },
    };
  },
);
afterAll(() => {
  assert.ok(comparisons > 0, "Actual native restore must execute");
  const report = JSON.stringify({ nativeBootstrapComparisons: comparisons });
  if (process.env.CANTRIP_HISTORY_PROJECTOR_REPORT)
    appendFileSync(process.env.CANTRIP_HISTORY_PROJECTOR_REPORT, report + "\n");
  console.log(report);
});
