import assert from "node:assert/strict";
import test from "node:test";
import { shouldRestartNativeFixture } from "./qa/workspace-native-restart.mjs";

test("native QA restarts graceful exit only when explicitly requested", () => {
  const result = { code: 0, signal: null };
  assert.equal(shouldRestartNativeFixture(result, {}), false);
  assert.equal(
    shouldRestartNativeFixture(result, { CANTRIP_QA_RESTART_ON_EXIT: "true" }),
    true,
  );
  assert.equal(
    shouldRestartNativeFixture(result, {
      CANTRIP_QA_RESTART_AFTER_CRASH: "true",
    }),
    false,
  );
});

test("native QA crash restart requires an actual SIGKILL and explicit opt-in", () => {
  const result = { code: null, signal: "SIGKILL" };
  assert.equal(shouldRestartNativeFixture(result, {}), false);
  assert.equal(
    shouldRestartNativeFixture(result, { CANTRIP_QA_RESTART_ON_EXIT: "true" }),
    false,
  );
  assert.equal(
    shouldRestartNativeFixture(result, {
      CANTRIP_QA_RESTART_AFTER_CRASH: "true",
    }),
    true,
  );
});

test("native QA never retries application failures or launcher shutdown", () => {
  const environment = {
    CANTRIP_QA_RESTART_ON_EXIT: "true",
    CANTRIP_QA_RESTART_AFTER_CRASH: "true",
  };
  for (const result of [
    { code: 1, signal: null },
    { code: null, signal: "SIGTERM" },
    { code: null, signal: "SIGINT" },
    { code: null, signal: null },
  ]) {
    assert.equal(shouldRestartNativeFixture(result, environment), false);
  }
});
