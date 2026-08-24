"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { openGraphicalSettings } = require("../src/settings.js");

test("opens the built-in graphical user settings editor", async () => {
  const commands = [];
  const result = await openGraphicalSettings({
    async executeCommand(command) {
      commands.push(command);
    },
  });

  assert.deepEqual(commands, ["workbench.action.openSettings"]);
  assert.deepEqual(result, { opened: true });
});

test("propagates a settings editor command failure", async () => {
  await assert.rejects(
    openGraphicalSettings({
      async executeCommand() {
        throw new Error("settings unavailable");
      },
    }),
    /settings unavailable/u,
  );
});
