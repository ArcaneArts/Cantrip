"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { openGraphicalExtensions } = require("../src/extensions.js");

test("opens the built-in Extensions view", async () => {
  const commands = [];
  const result = await openGraphicalExtensions({
    async executeCommand(command) {
      commands.push(command);
    },
  });

  assert.deepEqual(commands, ["workbench.view.extensions"]);
  assert.deepEqual(result, { opened: true });
});

test("propagates an Extensions view command failure", async () => {
  await assert.rejects(
    openGraphicalExtensions({
      async executeCommand() {
        throw new Error("extensions unavailable");
      },
    }),
    /extensions unavailable/u,
  );
});
