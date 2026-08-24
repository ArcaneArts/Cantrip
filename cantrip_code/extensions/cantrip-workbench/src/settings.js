"use strict";

async function openGraphicalSettings(commands) {
  await commands.executeCommand("workbench.action.openSettings");
  return { opened: true };
}

module.exports = { openGraphicalSettings };
