"use strict";

const path = require("node:path");

async function openGraphicalExtensions(commands) {
  // The Cantrip settings surface combines the Settings editor with the
  // Extensions side bar. Opening only the side bar leaves VS Code's startup
  // editor (usually Welcome) visible in the main pane.
  await commands.executeCommand("workbench.action.openSettings");
  await commands.executeCommand("workbench.view.extensions");
  return { opened: true };
}

async function installVsix(vscode, vsixPath) {
  if (
    typeof vsixPath !== "string" ||
    !path.isAbsolute(vsixPath) ||
    !vscode.Uri.file(vsixPath).fsPath.toLowerCase().endsWith(".vsix")
  ) {
    throw new Error("Cantrip requires a worker-local VSIX file.");
  }
  await vscode.commands.executeCommand(
    "workbench.extensions.installExtension",
    vscode.Uri.file(vsixPath),
    { donotSync: true },
  );
  return { installed: true };
}

module.exports = { installVsix, openGraphicalExtensions };
