"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { forceColorTheme } = require("../src/theme.js");

function configuration(workspaceValue) {
  const updates = [];
  return {
    inspect(key) {
      assert.equal(key, "colorTheme");
      return { workspaceValue };
    },
    async update(key, value, target) {
      updates.push({ key, target, value });
    },
    updates,
  };
}

test("forces an already-configured theme through a real configuration change", async () => {
  const workbench = configuration("Cantrip Dark");

  await forceColorTheme(workbench, "Cantrip Dark", "workspace");

  assert.deepEqual(workbench.updates, [
    { key: "colorTheme", target: "workspace", value: undefined },
    { key: "colorTheme", target: "workspace", value: "Cantrip Dark" },
  ]);
});

test("applies a different theme without an unnecessary reset", async () => {
  const workbench = configuration("Cantrip Light");

  await forceColorTheme(workbench, "Cantrip Dark", "workspace");

  assert.deepEqual(workbench.updates, [
    { key: "colorTheme", target: "workspace", value: "Cantrip Dark" },
  ]);
});
