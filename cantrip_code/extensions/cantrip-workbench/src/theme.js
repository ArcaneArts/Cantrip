"use strict";

const { themeNameForAppearance } = require("./protocol.js");

async function forceColorTheme(configuration, theme, target) {
  const current = configuration.inspect("colorTheme")?.workspaceValue;
  if (current === theme) {
    await configuration.update("colorTheme", undefined, target);
  }
  await configuration.update("colorTheme", theme, target);
}

async function syncConfiguredColorTheme(
  cantripConfiguration,
  workbenchConfiguration,
  target,
) {
  const theme = themeNameForAppearance(
    cantripConfiguration.get("appearance", null),
  );
  if (!theme) return false;
  await forceColorTheme(workbenchConfiguration, theme, target);
  return true;
}

module.exports = { forceColorTheme, syncConfiguredColorTheme };
