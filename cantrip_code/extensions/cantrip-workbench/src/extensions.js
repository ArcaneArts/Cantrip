"use strict";

async function openGraphicalExtensions(commands) {
  await commands.executeCommand("workbench.view.extensions");
  return { opened: true };
}

module.exports = { openGraphicalExtensions };
