// Unchanged behavioral tests execute both implementations, then consume the
// native result. Each call starts a real native process with Node off its PATH.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { afterAll, vi } from "vitest";
let comparisons = 0;
function native(input: unknown, expected: unknown) {
  const actual = JSON.parse(
    execFileSync(process.env.CANTRIP_NATIVE_HISTORY_FIXTURE!, [], {
      input: JSON.stringify(input) + "\n",
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    }),
  );
  assert.equal(actual.ok, true, actual.error);
  assert.deepEqual(actual.value, expected, "Node/native presentation");
  assert.ok(
    JSON.stringify(actual.value) === JSON.stringify(expected),
    "Exact presentation JSON property order",
  );
  comparisons++;
  return actual.value;
}
vi.mock(
  "../../tests/reference-node-worker/src/native-history-render.js",
  async (importOriginal) => {
    const source =
      await importOriginal<
        typeof import("../../tests/reference-node-worker/src/native-history-render.js")
      >();
    return {
      ...source,
      renderNativeHistoryItem: (
        item: unknown,
        context: Record<string, unknown> & {
          inputParts?: Map<number, unknown>;
        },
      ) => {
        const expected = source.renderNativeHistoryItem(
          item as never,
          context as never,
        );
        return native(
          {
            op: "presentation.render",
            item,
            context: {
              ...context,
              ...(context.inputParts
                ? { inputParts: Object.fromEntries(context.inputParts) }
                : {}),
            },
          },
          expected,
        );
      },
    };
  },
);
vi.mock(
  "../../tests/reference-node-worker/src/codex/event-normalization.js",
  async (importOriginal) => {
    const source =
      await importOriginal<
        typeof import("../../tests/reference-node-worker/src/codex/event-normalization.js")
      >();
    return {
      ...source,
      normalizeCodexThreadItem: (
        ...args: Parameters<typeof source.normalizeCodexThreadItem>
      ) => {
        const expected = source.normalizeCodexThreadItem(...args);
        const [item, cwd, lifecycle, correlation, telemetry = {}] = args;
        return native(
          {
            op: "presentation.normalize",
            item,
            cwd,
            lifecycle,
            correlation,
            telemetry,
          },
          expected,
        );
      },
    };
  },
);
afterAll(() => {
  assert.ok(comparisons > 0, "Native presentation must actually execute");
  const report = JSON.stringify({
    nativePresentationComparisons: comparisons,
    freshProcessPerCall: true,
  });
  if (process.env.CANTRIP_HISTORY_RENDER_REPORT)
    appendFileSync(process.env.CANTRIP_HISTORY_RENDER_REPORT, report + "\n");
  console.log(report);
});
