import assert from "node:assert/strict";

// These four mutations each change exactly one durable project alert. Replays,
// rejected writes and already-terminal requests must never add a notification.
const alertMutations = new Set([
  "encrypted interaction request",
  "clear retains accepted encrypted response",
  "computer-use encrypted approval",
  "computer-use terminal approval",
]);

export async function nativeEventDelivery(live, start, name) {
  const cursor = live.history
    .slice(0, start)
    .reduce((n, v) => (v.type === "event" ? Math.max(n, v.cursor) : n), 0);
  if (alertMutations.has(name)) {
    await live.message(
      (v) =>
        v.type === "event" &&
        v.resource === "project-alert" &&
        v.cursor > cursor,
    );
  }
  await live.ping(name);
  const events = live.history.slice(start).filter((v) => v.type === "event");
  assert.equal(
    events.filter((v) => v.resource === "project-alert").length,
    alertMutations.has(name) ? 1 : 0,
    name + " exact committed alert count",
  );
  let previous = cursor;
  for (const event of events) {
    assert.ok(
      event.cursor > previous,
      name + " strictly increasing raw cursors",
    );
    previous = event.cursor;
    assert.ok(
      Date.parse(event.occurredAt) >= Date.now() - 300000 &&
        Date.parse(event.occurredAt) <= Date.now() + 1000,
      name + " real publication clock",
    );
  }
  return events;
}

export function compareNativeEventTraces(
  actual,
  expected,
  databaseMode,
  label,
) {
  assert.equal(
    actual.length,
    expected.length,
    label + " exact operation count",
  );
  for (let i = 0; i < actual.length; i++) {
    const left = actual[i],
      right = expected[i];
    assert.equal(left.name, right.name, label + " operation order");
    if (databaseMode === "pglite" || !alertMutations.has(left.name)) {
      assert.deepEqual(
        left.events,
        right.events,
        label + " " + left.name + " exact trace",
      );
      continue;
    }
    // PostgreSQL delivers NOTIFY on a separate TCP connection. The schedule
    // suite demonstrates both orders in the actual unchanged Source server by
    // withholding real commit responses or notifications. Keep raw deliveries
    // in the report and compare both complete producer streams without sorting.
    for (const trace of [left.events, right.events]) {
      assert.ok(
        [
          "project-alert,agent-interaction,chat",
          "agent-interaction,chat,project-alert",
        ].includes(trace.map((v) => v.resource).join(",")),
        label + " " + left.name + " exact causal group",
      );
    }
    for (const notification of [false, true]) {
      const stream = (trace) =>
        trace.filter((v) => (v.resource === "project-alert") === notification);
      assert.deepEqual(
        stream(left.events),
        stream(right.events),
        label +
          " " +
          left.name +
          (notification
            ? " database notification"
            : " handler publication order"),
      );
    }
  }
}
