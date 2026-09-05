import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { smokeCuaModelImageEncoder } from "./model-image-smoke.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("model encoder smoke actually loads Sharp from the supplied worker layout", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-cua-model-smoke-"),
  );
  try {
    await assert.rejects(smokeCuaModelImageEncoder(directory), {
      code: "MODULE_NOT_FOUND",
    });
    await mkdir(path.join(directory, "node_modules"));
    await symlink(
      await realpath(path.join(root, "cantrip_worker/node_modules/sharp")),
      path.join(directory, "node_modules/sharp"),
      "junction",
    );
    const report = await smokeCuaModelImageEncoder(directory);
    assert.equal(report.sharpVersion, "0.34.4");
    assert.ok(report.inputBytes > 2.5 * 1024 * 1024);
    assert.ok(report.outputBytes <= 2.5 * 1024 * 1024);
    assert.ok(report.width * report.height <= 600_000);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
