import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("browser and Tauri development keep separate encrypted state", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const browserLauncher = packageJson.scripts?.dev ?? "";
  const desktopLauncher = await readFile(
    path.join(repositoryRoot, "scripts", "devtop.mjs"),
    "utf8",
  );

  assert.match(
    browserLauncher,
    /CANTRIP_DATA_DIR=\.\.\/\.cantrip\/browser-dev/u,
  );
  assert.match(
    browserLauncher,
    /CANTRIP_WORKER_DATA_DIR=\.\.\/\.cantrip\/browser-dev\/worker/u,
  );
  assert.match(browserLauncher, /VITE_CANTRIP_LOCAL_ONLY=true/u);
  assert.match(desktopLauncher, /\.\.\/\.cantrip\/dev/u);
  assert.doesNotMatch(desktopLauncher, /\.cantrip\/browser-dev/u);
});
