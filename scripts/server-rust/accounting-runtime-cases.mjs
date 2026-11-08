import assert from "node:assert/strict";

// Only the normal fresh-store cells assert a fixed startup/close sequence.
// Runtime SQL/callback failure semantics have separate comparisons.
export function verifyAccountingRuntime(records) {
  const accounting = records.filter((record) =>
    record.context?.event?.startsWith("account-usage."),
  );
  assert.deepEqual(
    accounting.map((record) => record.context.event),
    [
      "account-usage.storage-reconciliation.started",
      "account-usage.storage-reconciliation.completed",
      "account-usage.history-maintenance.completed",
      "account-usage.bandwidth-flush.completed",
    ],
    "Actual startup reconciliation/history and final usage flush are captured",
  );
  for (const record of accounting.slice(1))
    assert.ok(
      Number.isFinite(record.context.durationMs) &&
        record.context.durationMs >= 0,
    );
  return accounting.map((record) => {
    const copy = structuredClone(record);
    delete copy.timestamp;
    delete copy.cursor;
    delete copy.context.durationMs;
    return copy;
  });
}
