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

test("keeps the primary sidebar and notifications available for Extensions", async () => {
  const commands = [];

  assert.equal(
    await configureWorkbenchPresentation(configuration("extensions"), {
      async executeCommand(command) {
        commands.push(command);
      },
    }),
    true,
  );
  assert.deepEqual(commands, [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.closePanel",
  ]);
});

test("applies the restricted Extensions presentation", async () => {
  const updates = [];
  const commands = [];
  const workspace = {
    getConfiguration(section) {
      return {
        inspect() {
          return { workspaceValue: undefined };
        },
        async update(key, value, target) {
          updates.push([section, key, value, target]);
        },
      };
    },
  };

  await setWorkbenchPresentation(
    "extensions",
    workspace,
    {
      async executeCommand(command) {
        commands.push(command);
      },
    },
    "workspace",
  );

  assert.deepEqual(updates[0], [
    "cantrip",
    "presentation",
    "extensions",
    "workspace",
  ]);
  assert.deepEqual(commands, [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.closePanel",
  ]);
});

test("applies editor-only settings without changing ordinary workbenches", async () => {
  const updates = [];
  const commands = [];
  const workspace = {
    getConfiguration(section) {
      return {
        get() {
          return undefined;
        },
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

test("does not rewrite editor-only settings that already have the desired value", async () => {
  const updates = [];
  const commands = [];
  const desiredValues = new Map([
    ["cantrip.presentation", "editor"],
    ...EDITOR_CONFIGURATION.map(([section, key, value]) => [
      `${section}.${key}`,
      value,
    ]),
  ]);
  const workspace = {
    getConfiguration(section) {
      return {
        get(key) {
          return desiredValues.get(`${section}.${key}`);
        },
        inspect(key) {
          return {
            workspaceValue: desiredValues.get(`${section}.${key}`),
          };
        },
        async update(key, value, target) {
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
  assert.deepEqual(updates, []);
  assert.deepEqual(commands, [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.closeSidebar",
    "workbench.action.closePanel",
    "notifications.hideToasts",
    "notifications.clearAll",
  ]);
});

test("pins inherited editor-only values at workspace scope", async () => {
  const updates = [];
  const desiredValues = new Map([
    ["cantrip.presentation", "editor"],
    ...EDITOR_CONFIGURATION.map(([section, key, value]) => [
      `${section}.${key}`,
      value,
    ]),
  ]);
  const workspace = {
    getConfiguration(section) {
      return {
        get(key) {
          return desiredValues.get(`${section}.${key}`);
        },
        inspect() {
          return { globalValue: "inherited", workspaceValue: undefined };
        },
        async update(key, value, target) {
          updates.push([section, key, value, target]);
        },
      };
    },
  };

  await setWorkbenchPresentation(
    "editor",
    workspace,
    { executeCommand: async () => undefined },
    "workspace",
  );

  assert.equal(updates.length, EDITOR_CONFIGURATION.length + 1);
  assert.ok(updates.every(([, , , target]) => target === "workspace"));
});

test("defines every configurable editor-only chrome invariant", () => {
  assert.deepEqual(EDITOR_CONFIGURATION, [
    ["breadcrumbs", "enabled", false],
    ["debug", "toolBarLocation", "hidden"],
    ["editor.minimap", "enabled", false],
    ["extensions", "ignoreRecommendations", true],
    ["window", "commandCenter", false],
    ["workbench.activityBar", "location", "hidden"],
    ["workbench.editor", "editorActionsLocation", "hidden"],
    ["workbench.editor", "empty.hint", "hidden"],
    ["workbench.editor", "showTabs", "none"],
    ["workbench.navigationControl", "enabled", false],
    ["workbench", "startupEditor", "none"],
    ["workbench.layoutControl", "enabled", false],
    ["workbench.statusBar", "visible", false],
  ]);
});

test("treats already-hidden close commands as best-effort after applying authoritative config", async () => {
  const workspace = {
    getConfiguration() {
      return { get: () => undefined, update: async () => undefined };
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
        get() {
          return undefined;
        },
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
      {
        getConfiguration: () => ({
          get: () => undefined,
          update: async () => undefined,
        }),
      },
      { executeCommand: async () => undefined },
      "workspace",
    ),
    /Unsupported Cantrip presentation/u,
  );
});
