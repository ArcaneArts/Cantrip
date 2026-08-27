"use strict";

const EDITOR_CONFIGURATION = [
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
  const presentation = configuration.get("presentation", "workbench");
  const commandIds = ["workbench.action.closeAuxiliaryBar"];
  if (presentation === "editor") {
    commandIds.push(
      "workbench.action.closeSidebar",
      "workbench.action.closePanel",
      "notifications.hideToasts",
      "notifications.clearAll",
    );
  } else if (presentation === "extensions") {
    commandIds.push("workbench.action.closePanel");
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
  if (presentation !== "editor" && presentation !== "extensions") {
    throw new Error(`Unsupported Cantrip presentation: ${presentation}`);
  }
  const cantripConfiguration = workspace.getConfiguration("cantrip");
  if (
    cantripConfiguration.inspect?.("presentation")?.workspaceValue !==
    presentation
  ) {
    await cantripConfiguration.update(
      "presentation",
      presentation,
      configurationTarget,
    );
  }
  for (const [section, key, value] of EDITOR_CONFIGURATION) {
    const configuration = workspace.getConfiguration(section);
    if (configuration.inspect?.(key)?.workspaceValue !== value) {
      await configuration.update(key, value, configurationTarget);
    }
  }
  await configureWorkbenchPresentation(
    {
      get: (key, fallback) =>
        key === "presentation" ? presentation : fallback,
    },
    commands,
  );
  return true;
}

module.exports = {
  EDITOR_CONFIGURATION,
  configureWorkbenchPresentation,
  setWorkbenchPresentation,
};
