import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createBuildWorkspace,
  removeBuildWorkspace,
} from "./build-workspace.mjs";

test("creates disposable Code sources below a short temporary root", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-code-test-"),
  );
  try {
    const workspace = await createBuildWorkspace("win32-x64", {
      temporaryRoot,
    });
    assert.equal(path.dirname(path.dirname(workspace)), temporaryRoot);
    assert.match(path.basename(workspace), /^win32-x64-/u);
    assert.doesNotMatch(workspace, /[a-f0-9]{64}/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("retries cleanup without replacing the original build failure", async () => {
  let options;
  let warning;
  await removeBuildWorkspace("C:\\short\\cantrip-code", {
    remove: async (_directory, receivedOptions) => {
      options = receivedOptions;
      const error = new Error("resource busy");
      error.code = "EBUSY";
      throw error;
    },
    warn: (message) => {
      warning = message;
    },
  });

  assert.deepEqual(options, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
  assert.match(warning, /resource busy/u);
});
