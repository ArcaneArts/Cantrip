"use strict";

const EDITOR_CONFIGURATION = [
  ["breadcrumbs", "enabled", true],
  ["window", "commandCenter", false],
  ["window", "menuBarVisibility", "hidden"],
  ["workbench.activityBar", "location", "hidden"],
  ["workbench.editor", "editorActionsLocation", "hidden"],
  ["workbench.editor", "empty.hint", "hidden"],
  ["workbench.editor", "showTabs", "none"],
  ["workbench", "startupEditor", "none"],
  ["workbench.layoutControl", "enabled", false],
  ["workbench.statusBar", "visible", true],
];

async function executeLayoutCommand(commands, command) {
  try {
    await commands.executeCommand(command);
    return true;
  } catch {
    return false;
  }
}

async function configureWorkbenchPresentation(configuration, commands) {
  const commandIds = ["workbench.action.closeAuxiliaryBar"];
  if (configuration.get("presentation", "workbench") === "editor") {
    commandIds.push(
      "workbench.action.closeSidebar",
      "workbench.action.closePanel",
      "notifications.hideToasts",
      "notifications.clearAll",
    );
  }
  const results = [];
  for (const command of commandIds) {
    results.push(await executeLayoutCommand(commands, command));
  }
  return results.every(Boolean);
}

async function setWorkbenchPresentation(
  presentation,
  workspace,
  commands,
  configurationTarget,
) {
  if (presentation !== "editor") {
    throw new Error(`Unsupported Cantrip presentation: ${presentation}`);
  }
  await workspace
    .getConfiguration("cantrip")
    .update("presentation", presentation, configurationTarget);
  for (const [section, key, value] of EDITOR_CONFIGURATION) {
    await workspace
      .getConfiguration(section)
      .update(key, value, configurationTarget);
  }
  return configureWorkbenchPresentation(
    {
      get: (key, fallback) =>
        key === "presentation" ? presentation : fallback,
    },
    commands,
  );
}

module.exports = { configureWorkbenchPresentation, setWorkbenchPresentation };
