import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODE_BUILD_SCHEMA_VERSION,
  codeEntrypoint,
  createDistributionFileInventory,
  normalizeTarget,
} from "./build-lib.mjs";

test("normalizes documented target aliases", () => {
  assert.deepEqual(normalizeTarget("macos-arm64"), {
    platform: "darwin",
    arch: "arm64",
    id: "darwin-arm64",
  });
  assert.equal(normalizeTarget("windows-x64").id, "win32-x64");
  assert.equal(normalizeTarget("linux-armhf").id, "linux-armhf");
  assert.throws(() => normalizeTarget("darwin-armhf"));
  assert.equal(CODE_BUILD_SCHEMA_VERSION, 2);
});

test("chooses the packaged server entrypoint for each operating system", () => {
  assert.equal(
    codeEntrypoint(normalizeTarget("darwin-arm64"), "/code"),
    path.join("/code", "bin", "cantrip-code"),
  );
  assert.equal(
    codeEntrypoint(normalizeTarget("windows-x64"), "C:\\code"),
    path.join("C:\\code", "bin", "cantrip-code.cmd"),
  );
});

test("distribution inventory is stable and detects executable files", async () => {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "cantrip-code-inventory-")),
  );
  try {
    await mkdir(path.join(directory, "bin"));
    await writeFile(path.join(directory, "plain.txt"), "plain");
    await writeFile(path.join(directory, "bin", "cantrip-code"), "run", {
      mode: 0o755,
    });
    const inventory = await createDistributionFileInventory(directory);
    assert.deepEqual(
      inventory.map((entry) => entry.path),
      ["bin/cantrip-code", "plain.txt"],
    );
    assert.equal(inventory[0].executable, true);
    assert.equal(inventory[1].executable, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
