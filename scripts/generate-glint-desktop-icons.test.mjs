import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(join(repositoryRoot, path));
}

function svg(path) {
  return read(path).toString("utf8");
}

function circleCenters(source) {
  return [...source.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)].map(
    ([, x, y]) => [Number(x), Number(y)],
  );
}

function trayCells(source) {
  return [
    ...source.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="2" height="2"/g),
  ].map(([, x, y]) => [Number(x), Number(y)]);
}

function pngDimensions(path) {
  const image = read(path);
  assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
  return [image.readUInt32BE(16), image.readUInt32BE(20)];
}

function assertOpaquePng(path) {
  const image = read(path);
  assert.ok(
    image[25] !== 4 && image[25] !== 6,
    `${path} must not contain an alpha channel`,
  );
}

test("app icon artwork preserves the canonical glint geometry", () => {
  const canonical = circleCenters(svg("cantrip_app/src-tauri/icons/glint.svg"));
  assert.equal(canonical.length, 35);
  assert.deepEqual(
    circleCenters(svg("cantrip_app/src-tauri/icons/source.svg")),
    canonical,
  );
});

test("app artwork keeps the tall glint inside a five-unit safe area", () => {
  const source = svg("cantrip_app/src-tauri/icons/source.svg");
  const transform = source.match(
    /transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/,
  );
  assert.ok(transform);
  const translateX = Number(transform[1]);
  const translateY = Number(transform[2]);
  const scale = Number(transform[3]);
  const circles = circleCenters(source);
  const left = Math.min(...circles.map(([x]) => translateX + (x - 1) * scale));
  const right = Math.max(...circles.map(([x]) => translateX + (x + 1) * scale));
  const top = Math.min(...circles.map(([, y]) => translateY + (y - 1) * scale));
  const bottom = Math.max(
    ...circles.map(([, y]) => translateY + (y + 1) * scale),
  );
  assert.ok(left >= 5 && 36 - right >= 5);
  assert.ok(top >= 5 && 36 - bottom >= 5);
});

test("macOS tray renders a bold pixel-snapped SVG as an unscaled native template", () => {
  const rust = svg("cantrip_app/src-tauri/src/lib.rs");
  const tray = svg("cantrip_app/src-tauri/icons/tray-icon-macos.svg");
  const expectedCells = circleCenters(
    svg("cantrip_app/src-tauri/icons/glint.svg"),
  ).map(([x, y]) => [Math.floor((x + 2) / 2), Math.floor((y + 1) / 2)]);
  assert.deepEqual(
    trayCells(tray),
    expectedCells,
    "tray cells must remain a pixel-snapped projection of the canonical glint",
  );
  assert.match(tray, /viewBox="0 0 18 18"/);
  assert.match(tray, /shape-rendering="crispEdges"/);
  assert.match(rust, /include_bytes!\("\.\.\/icons\/tray-icon-macos\.svg"\)/);
  assert.match(rust, /include_bytes!\("\.\.\/icons\/tray-icon-macos\.png"\)/);
  assert.match(rust, /NSImage::initWithData/);
  assert.match(rust, /image\.setTemplate\(true\)/);
  assert.match(rust, /NSImageScaling::ScaleNone/);
  assert.deepEqual(
    pngDimensions("cantrip_app/src-tauri/icons/tray-icon-macos.png"),
    [18, 18],
  );
  assert.doesNotMatch(rust, /tray-icon-macos\.rgba/);
});

test("generated Apple touch and app icons have their platform dimensions", () => {
  const expectedDimensions = new Map([
    [
      "cantrip_app/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
      [1024, 1024],
    ],
    ["cantrip_app/src-tauri/icons/ios/AppIcon-60x60@3x.png", [180, 180]],
    ["cantrip_app/public/apple-touch-icon.png", [180, 180]],
    ["cantrip_site/public/apple-touch-icon.png", [180, 180]],
  ]);
  for (const [path, dimensions] of expectedDimensions) {
    assert.deepEqual(pngDimensions(path), dimensions);
    assertOpaquePng(path);
  }
});
