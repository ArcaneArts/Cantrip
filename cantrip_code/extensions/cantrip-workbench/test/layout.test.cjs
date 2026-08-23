"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  configureWorkbenchPresentation,
  setWorkbenchPresentation,
} = require("../src/layout.js");

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
    "notifications.hideToasts",
    "notifications.clearAll",
  ]);
});

test("applies editor-only settings without changing ordinary workbenches", async () => {
  const updates = [];
  const commands = [];
  const workspace = {
    getConfiguration(section) {
      return {
        async update(key, value, target) {
          if (section === "window" && key === "menuBarVisibility") {
            throw new Error("window.menuBarVisibility is application-scoped");
          }
          updates.push([section, key, value, target]);
        },
      };
    },
  };

  assert.equal(
    await setWorkbenchPresentation(
      "editor",
      workspace,
      {
        async executeCommand(command) {
          commands.push(command);
        },
      },
      "workspace",
    ),
    true,
  );
  assert.deepEqual(updates[0], [
    "cantrip",
    "presentation",
    "editor",
    "workspace",
  ]);
  assert.ok(
    updates.some(
      ([section, key, value]) =>
        section === "workbench.editor" &&
        key === "showTabs" &&
        value === "none",
    ),
  );
  assert.equal(
    updates.some(
      ([section, key]) => section === "window" && key === "menuBarVisibility",
    ),
    false,
  );
  assert.ok(
    updates.some(
      ([section, key, value]) =>
        section === "workbench.statusBar" &&
        key === "visible" &&
        value === true,
    ),
  );
  assert.deepEqual(commands, [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.closeSidebar",
    "workbench.action.closePanel",
    "notifications.hideToasts",
    "notifications.clearAll",
  ]);
});

test("rejects attempts to collapse a normal Code workbench", async () => {
  await assert.rejects(
    setWorkbenchPresentation(
      "workbench",
      { getConfiguration: () => ({ update: async () => undefined }) },
      { executeCommand: async () => undefined },
      "workspace",
    ),
    /Unsupported Cantrip presentation/u,
  );
});
