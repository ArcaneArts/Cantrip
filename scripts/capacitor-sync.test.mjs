import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  renderAndroidVersionProperties,
  renderIosVersionConfiguration,
  writeCapacitorVersionFiles,
} from "./capacitor-sync.mjs";

const version = { major: 1, minor: 1, patch: 1375, version: "1.1.1375" };

test("renders native Capacitor version values", () => {
  assert.match(
    renderAndroidVersionProperties(version),
    /CANTRIP_VERSION_NAME=1\.1\.1375\nCANTRIP_VERSION_CODE=1375/u,
  );
  assert.match(
    renderIosVersionConfiguration(version),
    /CANTRIP_VERSION = 1\.1\.1375\nCANTRIP_BUILD_NUMBER = 1375/u,
  );
});

test("writes generated Android and iOS version files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-version-"));
  try {
    const result = await writeCapacitorVersionFiles({ root, version });
    assert.equal(
      await readFile(result.androidPath, "utf8"),
      renderAndroidVersionProperties(version),
    );
    assert.equal(
      await readFile(result.iosPath, "utf8"),
      renderIosVersionConfiguration(version),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
