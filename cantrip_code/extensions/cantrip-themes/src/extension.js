"use strict";

const vscode = require("vscode");

const { syncConfiguredColorTheme } = require("./theme.js");

function syncTheme() {
  return syncConfiguredColorTheme(
    vscode.workspace.getConfiguration("cantrip"),
    vscode.workspace.getConfiguration("workbench"),
    vscode.ConfigurationTarget.Workspace,
  );
}

async function activate(context) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cantrip.appearance")) {
        void syncTheme().catch(() => false);
      }
    }),
  );
  await syncTheme().catch(() => false);
}

function deactivate() {}

module.exports = { activate, deactivate };
