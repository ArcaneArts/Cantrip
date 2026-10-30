// The response body can finish before preceding async Source onResponse hooks.
// Observe its final real hook rather than treating a different socket as one.
import assert from "node:assert/strict";
import { eventually } from "./audit-observations.mjs";

export function completedResponse(fixture, label) {
  return fixture.server.events.find(
    (event) =>
      event.event === "fixture.response.completed" &&
      fixture.requests.get(event.requestId) === label,
  );
}
export async function observeResponseCompletion(fixture, label) {
  assert.equal(fixture.kind, "node");
  return eventually(
    () => completedResponse(fixture, label),
    (value) =>
      assert.ok(value, `Actual Node onResponse has not completed: ${label}`),
  );
}
