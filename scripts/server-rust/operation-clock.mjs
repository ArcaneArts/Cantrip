// Fixture-only clock observations bracket the real operation in its process.
// Parent-process wall-clock readings remain diagnostic observations.
import assert from "node:assert/strict";

export function startOperationClock() {
  const before = Date.now();
  const started = process.hrtime.bigint();
  return () => ({
    before,
    after: Date.now(),
    elapsedNanoseconds: (process.hrtime.bigint() - started).toString(),
  });
}

export function assertGeneratedAtInOperation(timing) {
  const clock = timing.operationClock;
  const diagnostic = JSON.stringify(timing);
  assert.ok(clock, diagnostic);
  assert.ok(Number.isSafeInteger(clock.before), diagnostic);
  assert.ok(Number.isSafeInteger(clock.after), diagnostic);
  assert.match(clock.elapsedNanoseconds, /^\d+$/, diagnostic);
  const generated = Date.parse(timing.actualGeneratedAt);
  assert.ok(
    Number.isSafeInteger(generated) &&
      generated >= clock.before &&
      generated <= clock.after,
    diagnostic,
  );
}
