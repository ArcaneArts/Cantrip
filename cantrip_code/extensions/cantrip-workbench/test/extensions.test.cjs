"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  installVsix,
  openGraphicalExtensions,
} = require("../src/extensions.js");

test("opens Settings beside the built-in Extensions view", async () => {
  const commands = [];
  const result = await openGraphicalExtensions({
    async executeCommand(command) {
      commands.push(command);
    },
  });

  assert.deepEqual(commands, [
    "workbench.action.openSettings",
    "workbench.view.extensions",
  ]);
  assert.deepEqual(result, { opened: true });
});

test("propagates an Extensions view command failure", async () => {
  await assert.rejects(
    openGraphicalExtensions({
      async executeCommand() {
        throw new Error("extensions unavailable");
      },
    }),
    /extensions unavailable/u,
  );
});

test("delegates a worker-local VSIX to the built-in Code-OSS installer", async () => {
  const commands = [];
  const vscode = {
    Uri: {
      file(path) {
        return { fsPath: path, scheme: "file" };
      },
    },
    commands: {
      async executeCommand(...args) {
        commands.push(args);
      },
    },
  };

  await assert.doesNotReject(installVsix(vscode, "/tmp/upload.vsix"));
  assert.deepEqual(commands, [
    [
      "workbench.extensions.installExtension",
      { fsPath: "/tmp/upload.vsix", scheme: "file" },
      { donotSync: true },
    ],
  ]);
});

test("rejects a non-VSIX worker file before invoking Code-OSS", async () => {
  let called = false;
  const vscode = {
    Uri: { file: (path) => ({ fsPath: path }) },
    commands: {
      async executeCommand() {
        called = true;
      },
    },
  };

  await assert.rejects(installVsix(vscode, "/tmp/upload.zip"), /VSIX/u);
  await assert.rejects(installVsix(vscode, "upload.vsix"), /VSIX/u);
  assert.equal(called, false);
});
