import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconDirectory = join(repositoryRoot, "cantrip_app", "src-tauri", "icons");
const appIconSource = join(iconDirectory, "source.svg");
const trayIconSource = join(iconDirectory, "tray-icon-macos.svg");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cantrip-glint-icons-"));

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
    render(appIconSource, join(iconsetDirectory, filename), size);
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

  const trayPng = join(iconDirectory, "tray-icon-macos.png");
  render(trayIconSource, trayPng, 72);
  run("magick", [
    trayPng,
    "-depth",
    "8",
    `RGBA:${join(iconDirectory, "tray-icon-macos.rgba")}`,
  ]);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
