"use strict";

const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const themesDirectory = path.join(
  __dirname,
  "..",
  "..",
  "cantrip-themes",
  "themes",
);
const themesManifest = path.join(themesDirectory, "..", "package.json");

async function theme(name) {
  return JSON.parse(await readFile(path.join(themesDirectory, name), "utf8"));
}

test("ships themes in the browser extension host", async () => {
  const manifest = JSON.parse(await readFile(themesManifest, "utf8"));

  assert.equal(manifest.main, undefined);
  assert.equal(manifest.browser, "./src/extension.js");
  assert.deepEqual(manifest.extensionKind, ["ui"]);
  assert.deepEqual(manifest.activationEvents, ["*"]);
  assert.ok(
    manifest.contributes.configuration.properties["cantrip.appearance"],
  );
  assert.deepEqual(
    manifest.contributes.themes.map((item) => item.id),
    [
      "Cantrip Light",
      "Cantrip Dark",
      "Cantrip High Contrast Light",
      "Cantrip High Contrast Dark",
      "Cantrip Pro Light",
      "Cantrip Pro Dark",
      "Cantrip Pro High Contrast Light",
      "Cantrip Pro High Contrast Dark",
    ],
  );
});

test("uses subtle active-line fills without a high-contrast outline", async () => {
  const expectedFills = new Map([
    ["cantrip-dark.json", "#FFFFFF08"],
    ["cantrip-light.json", "#00000008"],
    ["cantrip-hc-dark.json", "#FFFFFF0D"],
    ["cantrip-hc-light.json", "#0000000D"],
  ]);

  for (const [name, fill] of expectedFills) {
    const colors = (await theme(name)).colors;
    assert.equal(colors["editor.lineHighlightBackground"], fill);
    assert.equal(colors["editor.lineHighlightBorder"], "#00000000");
  }
});

test("keeps the active line number visible in high-contrast themes", async () => {
  const expectedColors = new Map([
    [
      "cantrip-hc-dark.json",
      { activeForeground: "#FFFFFF", foreground: "#D0D0D0" },
    ],
    [
      "cantrip-hc-light.json",
      { activeForeground: "#000000", foreground: "#303030" },
    ],
  ]);

  for (const [name, expected] of expectedColors) {
    const colors = (await theme(name)).colors;
    assert.equal(
      colors["editorLineNumber.activeForeground"],
      expected.activeForeground,
    );
    assert.equal(colors["editorLineNumber.foreground"], expected.foreground);
    assert.notEqual(
      colors["editorLineNumber.activeForeground"],
      colors["editorLineNumber.foreground"],
    );
    assert.match(
      colors["editorLineNumber.activeForeground"],
      /^#[0-9A-F]{6}$/u,
    );
  }
});

test("keeps OLED surfaces pure while softening structural contrast", async () => {
  const dark = (await theme("cantrip-hc-dark.json")).colors;
  const light = (await theme("cantrip-hc-light.json")).colors;

  assert.equal(dark["editor.background"], "#000000");
  assert.equal(dark["sideBar.background"], "#000000");
  assert.equal(dark.contrastBorder, "#FFFFFF26");
  assert.equal(light["editor.background"], "#FFFFFF");
  assert.equal(light["sideBar.background"], "#FFFFFF");
  assert.equal(light.contrastBorder, "#00000026");
});

test("uses subtle fills instead of extreme high-contrast focus outlines", async () => {
  const themes = [
    {
      name: "cantrip-hc-dark.json",
      focusBorder: "#FFFFFF4D",
      focusedRowBackground: "#FFFFFF0D",
      transparent: "#FFFFFF00",
    },
    {
      name: "cantrip-hc-light.json",
      focusBorder: "#0000004D",
      focusedRowBackground: "#0000000D",
      transparent: "#00000000",
    },
  ];

  for (const expected of themes) {
    const colors = (await theme(expected.name)).colors;
    assert.equal(colors.focusBorder, expected.focusBorder);
    assert.equal(colors.contrastActiveBorder, expected.transparent);
    assert.equal(
      colors["settings.focusedRowBackground"],
      expected.focusedRowBackground,
    );
    assert.equal(colors["settings.focusedRowBorder"], expected.transparent);
  }
});

test("uses transparent structural surfaces for Pro Mode themes", async () => {
  const names = [
    "cantrip-pro-dark.json",
    "cantrip-pro-light.json",
    "cantrip-pro-hc-dark.json",
    "cantrip-pro-hc-light.json",
  ];
  const structuralColors = [
    "editor.background",
    "editorGroup.emptyBackground",
    "editorGroupHeader.tabsBackground",
    "sideBar.background",
    "activityBar.background",
    "titleBar.activeBackground",
    "statusBar.background",
    "panel.background",
    "terminal.background",
    "input.background",
  ];

  for (const name of names) {
    const colors = (await theme(name)).colors;
    for (const color of structuralColors) {
      assert.equal(colors[color], "#00000000", `${name}: ${color}`);
    }
    assert.match(colors["list.activeSelectionBackground"], /^(?:#.{8})$/u);
    assert.notEqual(colors["list.activeSelectionBackground"].slice(-2), "FF");
  }
});
