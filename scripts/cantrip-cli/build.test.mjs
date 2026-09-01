import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCantripCli,
  bundleCantripCli,
  cantripCliBinaryPath,
  cantripCliExecutableName,
} from "./build.mjs";

test("builds and bundles the worker CLI with platform naming", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-cli-build-"));
  try {
    const calls = [];
    const binary = buildCantripCli(root, {
      release: true,
      run(command, arguments_, options) {
        calls.push({ command, arguments_, options });
      },
    });
    assert.equal(binary, cantripCliBinaryPath(root, { release: true }));
    assert.equal(calls[0]?.command, "cargo");
    assert.deepEqual(calls[0]?.arguments_.slice(0, 2), ["build", "--locked"]);
    assert.ok(calls[0]?.arguments_.includes("--release"));

    const source = path.join(root, "fake-cantrip");
    const destination = path.join(root, "worker", "bin");
    await writeFile(source, "cantrip-cli-binary");
    const bundled = await bundleCantripCli(root, destination, {
      platform: "darwin",
      source,
    });
    assert.equal(await readFile(bundled, "utf8"), "cantrip-cli-binary");
    assert.equal((await stat(bundled)).mode & 0o111, 0o111);
    assert.equal(cantripCliExecutableName("win32"), "cantrip.exe");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses Cargo's configured target directory for build artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-cli-target-"));
  const previousCargoTargetDirectory = process.env.CARGO_TARGET_DIR;
  try {
    const cargoTargetDirectory = path.join(root, "shared-cargo-target");
    process.env.CARGO_TARGET_DIR = cargoTargetDirectory;
    const binary = buildCantripCli(root, {
      release: true,
      run() {},
    });
    assert.equal(
      binary,
      path.join(cargoTargetDirectory, "release", cantripCliExecutableName()),
    );

    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "shared-cantrip-cli");
    const destination = path.join(root, "worker", "bin");
    const bundled = await bundleCantripCli(root, destination, {
      platform: "darwin",
    });
    assert.equal(await readFile(bundled, "utf8"), "shared-cantrip-cli");
  } finally {
    if (previousCargoTargetDirectory === undefined) {
      delete process.env.CARGO_TARGET_DIR;
    } else {
      process.env.CARGO_TARGET_DIR = previousCargoTargetDirectory;
    }
    await rm(root, { force: true, recursive: true });
  }
});
