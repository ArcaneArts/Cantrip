import assert from "node:assert/strict";
import test from "node:test";
import { compareNativeEventTraces } from "./native-event-publication-trace.mjs";

const name = "computer-use encrypted approval";
const event = (resource, scope, entityId = null) => ({
  resource,
  scope,
  entityId,
  action: "invalidated",
  revision: null,
  payload: null,
});
const interaction = event("agent-interaction", {
  kind: "chat",
  chatId: "chat",
});
const summary = event(
  "chat",
  { kind: "project", projectId: "project" },
  "chat",
);
const alert = event("project-alert", { kind: "current-user" }, "project");
const trace = (events) => [{ name, events }];
const first = trace([alert, interaction, summary]);
const last = trace([interaction, summary, alert]);

test("PostgreSQL accepts both observed connection schedules and preserves the handler group", () => {
  compareNativeEventTraces(first, last, "postgres", "test");
  compareNativeEventTraces(last, first, "bundled-postgres", "test");
  assert.throws(() =>
    compareNativeEventTraces(
      trace([interaction, alert, summary]),
      first,
      "postgres",
      "test",
    ),
  );
  assert.throws(() =>
    compareNativeEventTraces(
      trace([alert, summary, interaction]),
      first,
      "postgres",
      "test",
    ),
  );
});
test("PGlite keeps its synchronous full-trace ordering requirement", () => {
  compareNativeEventTraces(first, structuredClone(first), "pglite", "test");
  assert.throws(() => compareNativeEventTraces(last, first, "pglite", "test"));
});
test("no missing, extra or duplicate notification can pass", () => {
  for (const events of [
    [interaction, summary],
    [alert, alert, interaction, summary],
    [alert, interaction, summary, summary],
    [alert, interaction],
  ]) {
    assert.throws(() =>
      compareNativeEventTraces(trace(events), first, "postgres", "test"),
    );
  }
});
test("complete event metadata and operation ordering remain authoritative", () => {
  for (const index of [0, 1, 2]) {
    for (const [key, value] of Object.entries({
      scope: { kind: "current-user", unexpected: true },
      entityId: "foreign",
      action: "deleted",
      revision: 42,
      payload: { unexpected: true },
    })) {
      const changed = structuredClone(first);
      changed[0].events[index][key] = value;
      assert.throws(
        () => compareNativeEventTraces(changed, first, "postgres", "test"),
        key + " on event " + index,
      );
    }
  }
  const changed = structuredClone(first);
  changed[0].name = "another operation";
  assert.throws(() =>
    compareNativeEventTraces(changed, first, "postgres", "test"),
  );
  assert.throws(() => compareNativeEventTraces([], first, "postgres", "test"));
  assert.throws(() =>
    compareNativeEventTraces([...first, ...first], first, "postgres", "test"),
  );
});
test("events without independent notifications retain exact total ordering", () => {
  const expected = [{ name: "plan event", events: [interaction, summary] }];
  const changed = [{ name: "plan event", events: [summary, interaction] }];
  assert.throws(() =>
    compareNativeEventTraces(changed, expected, "postgres", "test"),
  );
});
