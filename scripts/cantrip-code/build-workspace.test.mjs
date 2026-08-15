import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createBuildWorkspace,
  initializeBuildWorkspaceRepository,
  removeBuildWorkspace,
  resolveBuildWorkspaceRoot,
} from "./build-workspace.mjs";

test("keeps Windows native builds short and outside the Temporary directory", () => {
  const homeDirectory = "C:\\Users\\runneradmin";
  const temporaryDirectory = `${homeDirectory}\\AppData\\Local\\Temp`;
  const root = resolveBuildWorkspaceRoot({
    platform: "win32",
    homeDirectory,
    temporaryDirectory,
  });

  assert.equal(root, homeDirectory);
  const deepestReportedOutput = path.win32.join(
    root,
    "cantrip-code-",
    "win32-x64-XXXXXX",
    "source",
    "remote",
    "node_modules",
    "@vscode",
    "windows-process-tree",
    "build",
    "Release",
    "obj",
    "windows_process_tree",
    "src",
    "process_commandline.nativecodeanalysis.xml",
  );
  assert.ok(deepestReportedOutput.length < 260);
});

test("uses the ordinary temporary root on non-Windows hosts", () => {
  assert.equal(
    resolveBuildWorkspaceRoot({
      platform: "darwin",
      homeDirectory: "/Users/runner",
      temporaryDirectory: "/private/tmp",
    }),
    "/private/tmp",
  );
});

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

test("initializes repository-local Git configuration for Code postinstall", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-code-git-test-"),
  );
  try {
    await initializeBuildWorkspaceRepository(temporaryRoot);
    await new Promise((resolve, reject) => {
      const child = spawn("git", ["config", "pull.rebase", "merges"], {
        cwd: temporaryRoot,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (status) => {
        if (status === 0) resolve();
        else reject(new Error(`git config exited with ${status}`));
      });
    });
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
