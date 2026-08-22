"use strict";

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
    );
  }
  const results = [];
  for (const command of commandIds) {
    results.push(await executeLayoutCommand(commands, command));
  }
  return results.every(Boolean);
}

module.exports = { configureWorkbenchPresentation };
