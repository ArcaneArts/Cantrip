import assert from "node:assert/strict";
import test from "node:test";
import { checksumForArchive, nodeArchive } from "./toolchain.mjs";

test("maps Cantrip targets to official Node release archives", () => {
  assert.deepEqual(
    nodeArchive("22.21.1", { platform: "darwin", arch: "arm64" }),
    {
      basename: "node-v22.21.1-darwin-arm64",
      filename: "node-v22.21.1-darwin-arm64.tar.gz",
    },
  );
  assert.equal(
    nodeArchive("22.21.1", { platform: "linux", arch: "armhf" }).filename,
    "node-v22.21.1-linux-armv7l.tar.gz",
  );
  assert.equal(
    nodeArchive("22.21.1", { platform: "win32", arch: "x64" }).filename,
    "node-v22.21.1-win-x64.zip",
  );
});

test("selects an exact archive checksum", () => {
  const checksum = "a".repeat(64);
  assert.equal(
    checksumForArchive(
      `${"b".repeat(64)}  other.tar.gz\n${checksum}  wanted.tar.gz\n`,
      "wanted.tar.gz",
    ),
    checksum,
  );
  assert.throws(() => checksumForArchive("", "missing.tar.gz"));
});
