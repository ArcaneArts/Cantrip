import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconDirectory = join(repositoryRoot, "cantrip_app", "src-tauri", "icons");

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

function trayCellCenters(source) {
  return [
    ...source.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="2" height="2"/g),
  ].map(([, x, y]) => [Number(x) + 1, Number(y) + 1]);
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

test("app and tray variants preserve the canonical glint geometry", () => {
  const canonical = circleCenters(svg("cantrip_app/src-tauri/icons/glint.svg"));
  assert.equal(canonical.length, 35);
  assert.deepEqual(
    circleCenters(svg("cantrip_app/src-tauri/icons/source.svg")),
    canonical,
  );
  assert.deepEqual(
    trayCellCenters(svg("cantrip_app/src-tauri/icons/tray-icon-macos.svg")),
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

test("tray raster is an exact 2x, binary-alpha template image", () => {
  assert.deepEqual(
    pngDimensions("cantrip_app/src-tauri/icons/tray-icon-macos.png"),
    [36, 36],
  );
  const rgba = readFileSync(join(iconDirectory, "tray-icon-macos.rgba"));
  assert.equal(rgba.length, 36 * 36 * 4);
  const alpha = new Set();
  let opaquePixels = 0;
  for (let index = 3; index < rgba.length; index += 4) {
    alpha.add(rgba[index]);
    if (rgba[index] === 255) opaquePixels += 1;
  }
  assert.deepEqual(
    [...alpha].sort((a, b) => a - b),
    [0, 255],
  );
  assert.equal(opaquePixels, 35 * 2 * 2);
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
