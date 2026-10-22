import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTarget } from "./native-target.mjs";

test("normalizes packaging platform aliases without an editor dependency", () => {
  assert.deepEqual(normalizeTarget("macos-ARM64"), {
    platform: "darwin",
    arch: "arm64",
    id: "darwin-arm64",
  });
  assert.deepEqual(normalizeTarget("windows-x64"), {
    platform: "win32",
    arch: "x64",
    id: "win32-x64",
  });
  assert.deepEqual(normalizeTarget("linux-armhf"), {
    platform: "linux",
    arch: "armhf",
    id: "linux-armhf",
  });
});

test("uses the actual host by default and accepts a different packaging target", () => {
  const host = normalizeTarget();
  assert.equal(host.platform, process.platform);
  assert.equal(host.arch, process.arch);
  assert.equal(normalizeTarget("linux-x64").id, "linux-x64");
  assert.equal(normalizeTarget("win32-arm64").id, "win32-arm64");
});

test("rejects malformed and unsupported artifact target names", () => {
  for (const target of [
    "",
    "darwin",
    "plan9-x64",
    "linux-mips",
    "windows-armhf",
    "darwin-armhf",
  ]) {
    assert.throws(
      () => normalizeTarget(target),
      /(?:Invalid|Unsupported) native target/u,
    );
  }
});
