"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

require("tsx/cjs");
const {
  getCantripInitialColorTheme,
} = require("../../../upstream/src/vs/server/node/cantripTheme.ts");

const themesDirectory = path.resolve(__dirname, "../../cantrip-themes/themes");
function resolvedColors(name) {
  const theme = JSON.parse(
    readFileSync(path.join(themesDirectory, name), "utf8"),
  );
  return {
    ...(theme.include ? resolvedColors(path.basename(theme.include)) : {}),
    ...theme.colors,
  };
}

for (const [appearance, themeType, filename] of [
  ["light", "light", "cantrip-light.json"],
  ["dark", "dark", "cantrip-dark.json"],
  ["high-contrast-light", "hcLight", "cantrip-hc-light.json"],
  ["high-contrast-dark", "hcDark", "cantrip-hc-dark.json"],
  ["pro-light", "light", "cantrip-pro-light.json"],
  ["pro-dark", "dark", "cantrip-pro-dark.json"],
  ["pro-high-contrast-light", "hcLight", "cantrip-pro-hc-light.json"],
  ["pro-high-contrast-dark", "hcDark", "cantrip-pro-hc-dark.json"],
]) {
  test(`seeds ${appearance} before loading the configured theme`, () => {
    const initial = getCantripInitialColorTheme(appearance);
    const configured = resolvedColors(filename);
    assert.equal(initial.themeType, themeType);
    for (const [color, value] of Object.entries(initial.colors)) {
      assert.equal(value, configured[color], color);
    }
  });
}

for (const appearance of [undefined, "", "unknown", "toString", "__proto__"]) {
  test(`uses Cantrip dark when the startup appearance is ${String(appearance)}`, () => {
    assert.deepEqual(
      getCantripInitialColorTheme(appearance),
      getCantripInitialColorTheme("dark"),
    );
  });
}

test("supplies the worker's appearance as web startup configuration", () => {
  const source = readFileSync(
    path.resolve(
      __dirname,
      "../../../upstream/src/vs/server/node/webClientServer.ts",
    ),
    "utf8",
  );
  assert.match(
    source,
    /initialColorTheme: getCantripInitialColorTheme\(getFirstHeader\('x-cantrip-appearance'\)\)/u,
  );
});

test("uses a dark last-resort fallback without changing cached or explicit initial theme precedence", () => {
  const source = readFileSync(
    path.resolve(
      __dirname,
      "../../../upstream/src/vs/workbench/services/themes/browser/workbenchThemeService.ts",
    ),
    "utf8",
  );
  assert.match(
    source,
    /this\.settings\.getPreferredColorScheme\(\) \?\? ColorScheme\.DARK/u,
  );
  assert.doesNotMatch(source, /isWeb \? ColorScheme\.LIGHT/u);
  assert.ok(
    source.indexOf("ColorThemeData.fromStorageData") <
      source.indexOf("environmentService.options?.initialColorTheme"),
  );
  assert.ok(
    source.indexOf("environmentService.options?.initialColorTheme") <
      source.indexOf(
        "this.settings.getPreferredColorScheme() ?? ColorScheme.DARK",
      ),
  );
});
