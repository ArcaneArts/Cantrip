"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { forceColorTheme } = require("../src/theme.js");
const {
  syncConfiguredColorTheme,
} = require("../../cantrip-themes/src/theme.js");

function configuration(workspaceValue, globalValue) {
  const updates = [];
  return {
    inspect(key) {
      assert.equal(key, "colorTheme");
      return { workspaceValue, globalValue };
    },
    async update(key, value, target) {
      updates.push({ key, target, value });
    },
    updates,
  };
}

test("leaves an already-configured theme in place", async () => {
  const workbench = configuration("Cantrip Dark");

  await forceColorTheme(workbench, "Cantrip Dark", "workspace");

  assert.deepEqual(workbench.updates, []);
});

test("applies a different theme without an unnecessary reset", async () => {
  const workbench = configuration("Cantrip Light");

  await forceColorTheme(workbench, "Cantrip Dark", "workspace");

  assert.deepEqual(workbench.updates, [
    { key: "colorTheme", target: "workspace", value: "Cantrip Dark" },
  ]);
});

test("converges the workbench on the durable Cantrip appearance", async () => {
  const workbench = configuration("Cantrip Light");
  const cantrip = {
    get(key, fallback) {
      assert.equal(key, "appearance");
      assert.equal(fallback, null);
      return "pro-high-contrast-dark";
    },
  };

  assert.equal(
    await syncConfiguredColorTheme(cantrip, workbench, "workspace"),
    true,
  );
  assert.deepEqual(workbench.updates, [
    {
      key: "colorTheme",
      target: "workspace",
      value: "Cantrip Pro High Contrast Dark",
    },
  ]);
});

test("does not unset or rewrite an already-synchronized Cantrip appearance", async () => {
  const workbench = configuration("Cantrip Pro High Contrast Dark");
  const cantrip = { get: () => "pro-high-contrast-dark" };

  assert.equal(
    await syncConfiguredColorTheme(cantrip, workbench, "workspace"),
    true,
  );
  assert.deepEqual(workbench.updates, []);
});

test("pins a matching global theme at workspace scope without clearing it", async () => {
  const workbench = configuration(undefined, "Cantrip Dark");

  await forceColorTheme(workbench, "Cantrip Dark", "workspace");

  assert.deepEqual(workbench.updates, [
    { key: "colorTheme", target: "workspace", value: "Cantrip Dark" },
  ]);
});

test("propagates a failed theme update without first clearing the current theme", async () => {
  const workbench = configuration("Cantrip Light");
  workbench.update = async (key, value, target) => {
    workbench.updates.push({ key, value, target });
    throw new Error("configuration write failed");
  };

  await assert.rejects(
    forceColorTheme(workbench, "Cantrip Dark", "workspace"),
    /configuration write failed/u,
  );
  assert.deepEqual(workbench.updates, [
    { key: "colorTheme", target: "workspace", value: "Cantrip Dark" },
  ]);
});

test("ignores an invalid durable Cantrip appearance", async () => {
  const workbench = configuration("Cantrip Light");
  const cantrip = { get: () => "unknown" };

  assert.equal(
    await syncConfiguredColorTheme(cantrip, workbench, "workspace"),
    false,
  );
  assert.deepEqual(workbench.updates, []);
});
