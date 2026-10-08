"use strict";

async function forceColorTheme(configuration, theme, target) {
  const current = configuration.inspect("colorTheme")?.workspaceValue;
  if (current === theme) return;
  await configuration.update("colorTheme", theme, target);
}

module.exports = { forceColorTheme };
