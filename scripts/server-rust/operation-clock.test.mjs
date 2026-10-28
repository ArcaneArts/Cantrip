import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertGeneratedAtInOperation,
  startOperationClock,
} from "./operation-clock.mjs";

const base = Date.parse("2026-10-28T14:22:21.080Z");
const timing = (generated, overrides = {}) => ({
  label: "independent producer and parent clocks",
  kind: "clock regression",
  before: base - 2,
  after: base - 1,
  actualGeneratedAt: new Date(generated).toISOString(),
  operationClock: {
    before: base,
    after: base + 2,
    elapsedNanoseconds: "2000000",
  },
  ...overrides,
});

test("accepts both exact producer boundaries despite a parent clock offset", () => {
  for (const generated of [base, base + 2])
    assertGeneratedAtInOperation(timing(generated));
});

test("rejects a timestamp one millisecond outside either producer boundary", () => {
  for (const generated of [base - 1, base + 3])
    assert.throws(
      () =>
        assertGeneratedAtInOperation(
          timing(generated, { before: base - 10, after: base + 10 }),
        ),
      /independent producer and parent clocks/,
    );
});

test("rejects absent, invalid, and reversed producer observations", () => {
  for (const operationClock of [
    undefined,
    { before: null, after: base + 2, elapsedNanoseconds: "1" },
    { before: base, after: NaN, elapsedNanoseconds: "1" },
    { before: base + 2, after: base, elapsedNanoseconds: "1" },
    { before: base, after: base + 2, elapsedNanoseconds: "invalid" },
  ])
    assert.throws(() =>
      assertGeneratedAtInOperation(timing(base + 1, { operationClock })),
    );
  assert.throws(() =>
    assertGeneratedAtInOperation(
      timing(base + 1, { actualGeneratedAt: "invalid" }),
    ),
  );
});

test("captures real wall and monotonic readings around a generated timestamp", () => {
  const finish = startOperationClock();
  const actualGeneratedAt = new Date().toISOString();
  const operationClock = finish();
  assertGeneratedAtInOperation({ actualGeneratedAt, operationClock });
  assert.ok(BigInt(operationClock.elapsedNanoseconds) >= 0n);
});
