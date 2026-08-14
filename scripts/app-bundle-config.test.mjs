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

test("macOS DMGs use the branded installer background", async () => {
  const config = JSON.parse(
    await readFile(path.join(tauriDir, "tauri.macos.conf.json"), "utf8"),
  );
  const dmg = config.bundle?.macOS?.dmg;

  assert.deepEqual(dmg?.windowSize, { width: 660, height: 400 });
  assert.deepEqual(dmg?.appPosition, { x: 180, y: 170 });
  assert.deepEqual(dmg?.applicationFolderPosition, { x: 480, y: 170 });
  assert.equal(dmg?.background, "images/dmg-background.png");

  const background = await readFile(path.join(tauriDir, dmg.background));
  assert.equal(background.toString("ascii", 1, 4), "PNG");
  assert.equal(background.readUInt32BE(16), dmg.windowSize.width);
  assert.equal(background.readUInt32BE(20), dmg.windowSize.height);
});
