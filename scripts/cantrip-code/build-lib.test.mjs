import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODE_BUILD_SCHEMA_VERSION,
  codeEntrypoint,
  normalizeTarget,
} from "./build-lib.mjs";
import { verifyPackagedCantripCode } from "./packaged-manifest.mjs";

test("normalizes documented target aliases", () => {
  assert.deepEqual(normalizeTarget("macos-arm64"), {
    platform: "darwin",
    arch: "arm64",
    id: "darwin-arm64",
  });
  assert.equal(normalizeTarget("windows-x64").id, "win32-x64");
  assert.equal(normalizeTarget("linux-armhf").id, "linux-armhf");
  assert.throws(() => normalizeTarget("darwin-armhf"));
  assert.equal(CODE_BUILD_SCHEMA_VERSION, 3);
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

test("packaged Code validation ignores file additions and changes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-code-package-"),
  );
  try {
    const nativeLibrary = path.join(directory, "native.dylib");
    await writeFile(nativeLibrary, "unsigned");
    await writeFile(
      path.join(directory, "cantrip-code.manifest.json"),
      JSON.stringify({
        schemaVersion: 3,
        component: "cantrip-code",
        target: "darwin-arm64",
      }),
    );
    await writeFile(nativeLibrary, "signed");
    await writeFile(path.join(directory, "stale-but-harmless.txt"), "extra");

    await verifyPackagedCantripCode(directory, "darwin-arm64");
    await assert.rejects(
      verifyPackagedCantripCode(directory, "linux-x64"),
      /expected linux-x64/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
