"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { hideSecondarySideBar } = require("../src/layout.js");

test("hides the secondary side bar through the supported workbench command", async () => {
  const commands = [];

  assert.equal(
    await hideSecondarySideBar({
      async executeCommand(command) {
        commands.push(command);
      },
    }),
    true,
  );
  assert.deepEqual(commands, ["workbench.action.closeAuxiliaryBar"]);
});

test("keeps workbench activation resilient when the side bar is already hidden", async () => {
  assert.equal(
    await hideSecondarySideBar({
      async executeCommand() {
        throw new Error("Command is not enabled");
      },
    }),
    false,
  );
});
