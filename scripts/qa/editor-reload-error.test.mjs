import assert from "node:assert/strict";
import { test } from "node:test";
import { isEditorReloadTeardownError } from "./editor-reload-error.mjs";

const context = {
  browser: "webkit",
  reloadingRenderer: true,
  origin: "http://fixture.localhost:1234",
};
const message = (path) =>
  `/fixture.localhost:1234/api/worker-links/${path} due to access control checks.`;

test("classifies only known teardown endpoints during explicit WebKit reload", () => {
  for (const path of [
    "session", "session/telemetry", "session/grants/grant",
    "session/peers", "session/peers/peer", "session/peers/peer/signals",
  ]) {
    assert.equal(isEditorReloadTeardownError({ ...context, message: message(path) }), true, path);
  }
});

test("preserves failures outside reload, from other origins, and unrelated endpoints", () => {
  const base = { ...context, message: message("session/telemetry") };
  for (const override of [
    { browser: "chromium" },
    { reloadingRenderer: false },
    { origin: "http://other.localhost:1234" },
    { origin: "http://fixture.localhost:1235" },
    { message: message("session/commands") },
    { message: message("session/grants") },
    { message: message("session/peers/peer/unknown") },
    { message: "Uncaught TypeError: Cannot read properties of undefined" },
    { message: message("session") + " extra error" },
  ]) {
    assert.equal(isEditorReloadTeardownError({ ...base, ...override }), false, JSON.stringify(override));
  }
});
