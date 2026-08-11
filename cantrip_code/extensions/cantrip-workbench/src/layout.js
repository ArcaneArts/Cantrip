"use strict";

async function hideSecondarySideBar(commands) {
  try {
    await commands.executeCommand("workbench.action.closeAuxiliaryBar");
    return true;
  } catch {
    return false;
  }
}

module.exports = { hideSecondarySideBar };
