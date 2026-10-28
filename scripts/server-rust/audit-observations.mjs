// Sequence compatibility scenarios by actual source audit completion. Keep the
// exact audit list, IDs and cursor comparisons; responses are never reordered.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function eventually(read, check, milliseconds = 15000) {
  const until = Date.now() + milliseconds;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (error) {
      if (Date.now() >= until) throw error;
    }
    await delay(10);
  }
}

export async function auditRows(fixture, clientName) {
  const client = fixture.client(clientName);
  const response = await fetch(
    `${fixture.server.origin}/api/account/audit-events?limit=200`,
    {
      headers: {
        origin: "http://127.0.0.1:5173",
        ...(client.cookies.size
          ? {
              cookie: [...client.cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            }
          : {}),
      },
    },
  );
  assert.equal(response.status, 200, "Read actual persisted audits");
  return (await response.json()).items;
}

export async function observeAuditCompletion(
  fixture,
  { label, requestId, client },
) {
  if (fixture.kind === "node") {
    const completed = await eventually(
      () =>
        fixture.server.events.find(
          (e) =>
            e.event === "fixture.response.completed" &&
            e.requestId === requestId,
        ),
      (value) =>
        assert.ok(value, `Actual Node onResponse did not complete: ${label}`),
    );
    const writes = fixture.server.events.filter(
      (e) =>
        e.event === "fixture.audit.completed" &&
        e.requestId === requestId &&
        completed.ownerId !== null &&
        e.ownerId === completed.ownerId,
    );
    const effects = fixture.auditEffects.get(label) ?? [];
    effects.push(writes);
    fixture.auditEffects.set(label, effects);
    return;
  }
  assert.ok(
    fixture.auditReference,
    "Audit comparison requires the actual Node observation",
  );
  const offset = fixture.auditOffsets.get(label) ?? 0;
  const writes = fixture.auditReference.auditEffects.get(label)?.[offset];
  assert.ok(
    writes,
    `Missing actual Node audit observation: ${label}/${offset}`,
  );
  fixture.auditOffsets.set(label, offset + 1);
  const successful = writes.filter((w) => w.ok);
  if (successful.length) {
    await eventually(
      () => auditRows(fixture, client),
      (rows) => {
        const actual = rows.filter((row) => row.requestId === requestId);
        assert.equal(
          actual.length,
          successful.length,
          `Persisted audit count: ${label}`,
        );
        for (const write of successful)
          assert.equal(
            actual.filter((row) => row.action === write.action).length,
            successful.filter((row) => row.action === write.action).length,
            `Persisted audit actions: ${label}`,
          );
      },
    );
  }
  const failed = writes.filter((w) => !w.ok);
  if (failed.length) {
    await eventually(
      () =>
        fixture.server.events.filter(
          (e) =>
            e.event === "security.audit-write-failed" &&
            e.requestId === requestId,
        ),
      (events) =>
        assert.equal(
          events.length,
          failed.length,
          `Actual failed audit completion: ${label}`,
        ),
    );
  }
}
