import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

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

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function pngRgba(image) {
  assert.deepEqual(
    [...image.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const idat = [];
  let width;
  let height;
  for (let offset = 8; offset < image.length;) {
    const length = image.readUInt32BE(offset);
    const type = image.subarray(offset + 4, offset + 8).toString("ascii");
    const data = image.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([...data.subarray(8, 13)], [8, 6, 0, 0, 0]);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += length + 12;
  }
  assert.ok(width && height && idat.length > 0);
  const compressed = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = compressed[sourceOffset];
    sourceOffset += 1;
    assert.ok(filter >= 0 && filter <= 4);
    for (let column = 0; column < stride; column += 1) {
      const value = compressed[sourceOffset];
      sourceOffset += 1;
      const output = row * stride + column;
      const left = column >= 4 ? pixels[output - 4] : 0;
      const above = row > 0 ? pixels[output - stride] : 0;
      const upperLeft =
        row > 0 && column >= 4 ? pixels[output - stride - 4] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft);
      pixels[output] = (value + predictor) & 0xff;
    }
  }
  return pixels;
}

function icnsEntry(path, expectedType) {
  const icon = read(path);
  assert.equal(icon.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icon.readUInt32BE(4), icon.length);
  for (let offset = 8; offset < icon.length;) {
    const type = icon.subarray(offset, offset + 4).toString("ascii");
    const length = icon.readUInt32BE(offset + 4);
    if (type === expectedType)
      return icon.subarray(offset + 8, offset + length);
    offset += length;
  }
  assert.fail(`Missing ${expectedType} entry in ${path}`);
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

test("macOS ICNS alpha edges cannot leak a bright halo", () => {
  const pixels = pngRgba(
    icnsEntry("cantrip_app/src-tauri/icons/icon.icns", "ic12"),
  );
  let translucentPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha === 0 || alpha === 255) continue;
    translucentPixels += 1;
    assert.ok(pixels[index] <= 17);
    assert.ok(pixels[index + 1] <= 17);
    assert.ok(pixels[index + 2] <= 19);
  }
  assert.ok(translucentPixels > 0);
});

test("macOS tray renders the supplied bolt SVG as an unscaled native template", () => {
  const rust = svg("cantrip_app/src-tauri/src/lib.rs");
  const tray = svg("cantrip_app/src-tauri/icons/icons8-bolt.svg");
  assert.match(tray, /viewBox="0 0 24 24"/);
  assert.match(tray, /id="sharp"/);
  assert.match(tray, /polygon points="19,10 13,10 13,1 6,14 12,14 12,23 "/);
  assert.match(rust, /include_bytes!\("\.\.\/icons\/icons8-bolt\.svg"\)/);
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
