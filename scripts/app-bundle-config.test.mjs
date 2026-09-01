import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const tauriDir = path.join(rootDir, "cantrip_app", "src-tauri");

const readTomlSection = (source, heading) => {
  const marker = `[${heading}]`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing Cargo.toml section ${marker}`);
  const bodyStart = start + marker.length;
  const nextSection = source.indexOf("\n[", bodyStart);
  return source.slice(bodyStart, nextSection === -1 ? undefined : nextSection);
};

test("packaged apps declare the native icon assets", async () => {
  const config = JSON.parse(
    await readFile(path.join(tauriDir, "tauri.conf.json"), "utf8"),
  );
  const icons = config.bundle?.icon;

  assert.ok(Array.isArray(icons), "bundle.icon must be an array");
  assert.ok(icons.includes("icons/icon.icns"), "macOS icon is required");
  assert.ok(icons.includes("icons/icon.ico"), "Windows icon is required");
  assert.ok(
    icons.some((icon) => icon.endsWith(".png")),
    "PNG icon is required",
  );

  await Promise.all(icons.map((icon) => access(path.join(tauriDir, icon))));
});

test("packaged apps use signed static updater artifacts", async () => {
  const config = JSON.parse(
    await readFile(path.join(tauriDir, "tauri.conf.json"), "utf8"),
  );
  const updater = config.plugins?.updater;

  assert.equal(config.bundle?.createUpdaterArtifacts, true);
  assert.deepEqual(updater?.endpoints, [
    "https://github.com/ArcaneArts/Cantrip/releases/latest/download/latest.json",
  ]);
  assert.match(updater?.pubkey ?? "", /^[A-Za-z0-9+/]+=*$/u);
  assert.match(
    Buffer.from(updater.pubkey, "base64").toString("utf8"),
    /minisign public key/u,
  );
  assert.equal(updater?.windows?.installMode, "passive");
});

test("macOS DMGs use the branded installer background", async () => {
  const config = JSON.parse(
    await readFile(path.join(tauriDir, "tauri.macos.conf.json"), "utf8"),
  );
  const dmg = config.bundle?.macOS?.dmg;

  assert.deepEqual(dmg?.windowSize, { width: 660, height: 400 });
  assert.deepEqual(dmg?.appPosition, { x: 135, y: 190 });
  assert.deepEqual(dmg?.applicationFolderPosition, { x: 525, y: 190 });
  assert.equal(dmg?.background, "images/dmg-background.png");

  const background = await readFile(path.join(tauriDir, dmg.background));
  assert.equal(background.toString("ascii", 1, 4), "PNG");
  assert.equal(background.readUInt32BE(16), dmg.windowSize.width);
  assert.equal(background.readUInt32BE(20), dmg.windowSize.height);
});

test("Windows NSIS installers use Cantrip branding", async () => {
  const config = JSON.parse(
    await readFile(path.join(tauriDir, "tauri.windows.conf.json"), "utf8"),
  );
  const nsis = config.bundle?.windows?.nsis;

  assert.equal(nsis?.installerIcon, "icons/icon.ico");
  assert.equal(nsis?.uninstallerIcon, "icons/icon.ico");
  assert.equal(nsis?.headerImage, "images/nsis-header.bmp");
  assert.equal(nsis?.uninstallerHeaderImage, nsis.headerImage);
  assert.equal(nsis?.sidebarImage, "images/nsis-sidebar.bmp");
  assert.equal(nsis?.installMode, "currentUser");

  const assertBitmap = async (relativePath, width, height) => {
    const bitmap = await readFile(path.join(tauriDir, relativePath));
    assert.equal(bitmap.toString("ascii", 0, 2), "BM");
    assert.equal(bitmap.readUInt32LE(18), width);
    assert.equal(bitmap.readUInt32LE(22), height);
    assert.equal(bitmap.readUInt16LE(28), 24);
  };

  await assertBitmap(nsis.headerImage, 150, 57);
  await assertBitmap(nsis.sidebarImage, 164, 314);
});

test("macOS private API Cargo and Tauri config stay aligned on every target", async () => {
  const cargoToml = await readFile(path.join(tauriDir, "Cargo.toml"), "utf8");
  const commonDependencies = readTomlSection(cargoToml, "dependencies");
  const baseConfig = JSON.parse(
    await readFile(path.join(tauriDir, "tauri.conf.json"), "utf8"),
  );
  const macosConfig = JSON.parse(
    await readFile(path.join(tauriDir, "tauri.macos.conf.json"), "utf8"),
  );
  const windowsConfig = JSON.parse(
    await readFile(path.join(tauriDir, "tauri.windows.conf.json"), "utf8"),
  );

  assert.match(commonDependencies, /^tauri = .*"macos-private-api"/mu);
  assert.equal(baseConfig.app?.macOSPrivateApi, true);
  assert.equal(macosConfig.app?.macOSPrivateApi, undefined);
  assert.equal(windowsConfig.app?.macOSPrivateApi, undefined);
});
