"use strict";

const THEME_NAMES = {
  light: "Cantrip Light",
  dark: "Cantrip Dark",
  "high-contrast-light": "Cantrip High Contrast Light",
  "high-contrast-dark": "Cantrip High Contrast Dark",
  "pro-light": "Cantrip Pro Light",
  "pro-dark": "Cantrip Pro Dark",
  "pro-high-contrast-light": "Cantrip Pro High Contrast Light",
  "pro-high-contrast-dark": "Cantrip Pro High Contrast Dark",
};

function themeNameForAppearance(appearance) {
  return typeof appearance === "string"
    ? (THEME_NAMES[appearance] ?? null)
    : null;
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
  const current = workbenchConfiguration.inspect("colorTheme")?.workspaceValue;
  if (current === theme) {
    await workbenchConfiguration.update("colorTheme", undefined, target);
  }
  await workbenchConfiguration.update("colorTheme", theme, target);
  return true;
}

module.exports = { syncConfiguredColorTheme, themeNameForAppearance };
