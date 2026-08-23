"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EDITOR_CONFIGURATION,
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
        value === false,
    ),
  );
  assert.ok(
    updates.some(
      ([section, key, value]) =>
        section === "breadcrumbs" && key === "enabled" && value === false,
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

test("defines every configurable editor-only chrome invariant", () => {
  assert.deepEqual(EDITOR_CONFIGURATION, [
    ["breadcrumbs", "enabled", false],
    ["window", "commandCenter", false],
    ["workbench.activityBar", "location", "hidden"],
    ["workbench.editor", "editorActionsLocation", "hidden"],
    ["workbench.editor", "empty.hint", "hidden"],
    ["workbench.editor", "showTabs", "none"],
    ["workbench", "startupEditor", "none"],
    ["workbench.layoutControl", "enabled", false],
    ["workbench.statusBar", "visible", false],
  ]);
});

test("treats already-hidden close commands as best-effort after applying authoritative config", async () => {
  const workspace = {
    getConfiguration() {
      return { update: async () => undefined };
    },
  };

  await assert.doesNotReject(
    setWorkbenchPresentation(
      "editor",
      workspace,
      {
        async executeCommand(command) {
          if (command === "workbench.action.closePanel") {
            throw new Error("panel command failed");
          }
        },
      },
      "workspace",
    ),
  );
});

test("rejects presentation control when an authoritative config write fails", async () => {
  const workspace = {
    getConfiguration(section) {
      return {
        async update(key) {
          if (section === "workbench.statusBar" && key === "visible") {
            throw new Error("workspace settings are read-only");
          }
        },
      };
    },
  };

  await assert.rejects(
    setWorkbenchPresentation(
      "editor",
      workspace,
      { executeCommand: async () => undefined },
      "workspace",
    ),
    /workspace settings are read-only/u,
  );
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
