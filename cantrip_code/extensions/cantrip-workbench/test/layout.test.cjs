"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { configureWorkbenchPresentation } = require("../src/layout.js");

function configuration(presentation) {
  return {
    get(key, fallback) {
      return key === "presentation" ? presentation : fallback;
    },
  };
}

test("hides the secondary side bar through the supported workbench command", async () => {
  const commands = [];

  assert.equal(
    await configureWorkbenchPresentation(configuration("workbench"), {
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
    await configureWorkbenchPresentation(configuration("workbench"), {
      async executeCommand() {
        throw new Error("Command is not enabled");
      },
    }),
    false,
  );
});

test("closes non-editor parts for the editor-only presentation", async () => {
  const commands = [];

  assert.equal(
    await configureWorkbenchPresentation(configuration("editor"), {
      async executeCommand(command) {
        commands.push(command);
      },
    }),
    true,
  );
  assert.deepEqual(commands, [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.closeSidebar",
    "workbench.action.closePanel",
  ]);
});
