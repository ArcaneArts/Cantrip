import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconDirectory = join(repositoryRoot, "cantrip_app", "src-tauri", "icons");
const appIconSource = join(iconDirectory, "source.svg");
const trayIconSource = join(iconDirectory, "icons8-bolt.svg");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cantrip-glint-icons-"));
let opaqueRenderSequence = 0;
let alphaSafeRenderSequence = 0;

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function render(source, output, size) {
  run("rsvg-convert", [
    "-w",
    String(size),
    "-h",
    String(size),
    source,
    "-o",
    output,
  ]);
}

function renderAlphaSafe(source, output, size) {
  const intermediate = join(
    temporaryDirectory,
    `alpha-safe-${alphaSafeRenderSequence}.png`,
  );
  alphaSafeRenderSequence += 1;
  render(source, intermediate, size);
  // librsvg's translucent edge RGB is coverage-expanded when written as PNG.
  // Normalize it before iconutil so macOS cannot composite a bright fringe.
  run("magick", [
    intermediate,
    "-channel",
    "RGB",
    "-fx",
    "u*a",
    "+channel",
    "-strip",
    "-define",
    "png:color-type=6",
    output,
  ]);
}

function renderOpaque(source, output, size) {
  const intermediate = join(
    temporaryDirectory,
    `opaque-${opaqueRenderSequence}.png`,
  );
  opaqueRenderSequence += 1;
  render(source, intermediate, size);
  run("magick", [
    intermediate,
    "-background",
    "#111113",
    "-alpha",
    "remove",
    "-alpha",
    "off",
    "-strip",
    output,
  ]);
}

try {
  const pngOutputs = new Map([
    ["32x32.png", 32],
    ["64x64.png", 64],
    ["128x128.png", 128],
    ["128x128@2x.png", 256],
    ["icon.png", 512],
    ["StoreLogo.png", 50],
    ["Square30x30Logo.png", 30],
    ["Square44x44Logo.png", 44],
    ["Square71x71Logo.png", 71],
    ["Square89x89Logo.png", 89],
    ["Square107x107Logo.png", 107],
    ["Square142x142Logo.png", 142],
    ["Square150x150Logo.png", 150],
    ["Square284x284Logo.png", 284],
    ["Square310x310Logo.png", 310],
  ]);
  for (const [filename, size] of pngOutputs) {
    render(appIconSource, join(iconDirectory, filename), size);
  }

  const iconsetDirectory = join(temporaryDirectory, "icon.iconset");
  mkdirSync(iconsetDirectory);
  const icnsOutputs = new Map([
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ]);
  for (const [filename, size] of icnsOutputs) {
    renderAlphaSafe(appIconSource, join(iconsetDirectory, filename), size);
  }
  run("iconutil", [
    "--convert",
    "icns",
    "--output",
    join(iconDirectory, "icon.icns"),
    iconsetDirectory,
  ]);

  const icoSizes = [32, 16, 24, 48, 64, 256];
  const icoInputs = icoSizes.map((size) => {
    const output = join(temporaryDirectory, `icon-${size}.png`);
    render(appIconSource, output, size);
    return output;
  });
  run("magick", [...icoInputs, join(iconDirectory, "icon.ico")]);

  const iosIconDirectory = join(iconDirectory, "ios");
  const iosOutputs = new Map([
    ["AppIcon-20x20@1x.png", 20],
    ["AppIcon-20x20@2x-1.png", 40],
    ["AppIcon-20x20@2x.png", 40],
    ["AppIcon-20x20@3x.png", 60],
    ["AppIcon-29x29@1x.png", 29],
    ["AppIcon-29x29@2x-1.png", 58],
    ["AppIcon-29x29@2x.png", 58],
    ["AppIcon-29x29@3x.png", 87],
    ["AppIcon-40x40@1x.png", 40],
    ["AppIcon-40x40@2x-1.png", 80],
    ["AppIcon-40x40@2x.png", 80],
    ["AppIcon-40x40@3x.png", 120],
    ["AppIcon-512@2x.png", 1024],
    ["AppIcon-60x60@2x.png", 120],
    ["AppIcon-60x60@3x.png", 180],
    ["AppIcon-76x76@1x.png", 76],
    ["AppIcon-76x76@2x.png", 152],
    ["AppIcon-83.5x83.5@2x.png", 167],
  ]);
  for (const [filename, size] of iosOutputs) {
    renderOpaque(appIconSource, join(iosIconDirectory, filename), size);
  }
  renderOpaque(
    appIconSource,
    join(
      repositoryRoot,
      "cantrip_app",
      "ios",
      "App",
      "App",
      "Assets.xcassets",
      "AppIcon.appiconset",
      "AppIcon-512@2x.png",
    ),
    1024,
  );
  for (const output of [
    join(repositoryRoot, "cantrip_app", "public", "apple-touch-icon.png"),
    join(repositoryRoot, "cantrip_site", "public", "apple-touch-icon.png"),
  ]) {
    renderOpaque(appIconSource, output, 180);
  }

  render(trayIconSource, join(iconDirectory, "tray-icon-macos.png"), 18);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
