"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  openWorkspaceFile,
  WorkspaceFileNavigator,
} = require("../src/navigation.js");

function uri(value) {
  const parsed = new URL(value);
  return {
    authority: parsed.host,
    fragment: parsed.hash.slice(1),
    path: decodeURIComponent(parsed.pathname),
    query: parsed.search.slice(1),
    scheme: parsed.protocol.slice(0, -1),
    toString: () => value,
  };
}

function fixture({
  joinedUri,
  rootUri = "file:///repo",
  shownUri = "file:///repo/src/index.ts",
  workspaceFolderUris = ["file:///repo"],
} = {}) {
  const calls = [];
  const vscode = {
    Uri: {
      joinPath(root, ...segments) {
        return uri(joinedUri ?? `${root.toString()}/${segments.join("/")}`);
      },
      parse: (value) => uri(value),
    },
    workspace: {
      workspaceFolders: workspaceFolderUris.map((value) => ({
        uri: uri(value),
      })),
      async openTextDocument(candidate) {
        calls.push(["open", candidate.toString()]);
        return { uri: candidate };
      },
    },
    window: {
      async showTextDocument(document, options) {
        calls.push(["show", document.uri.toString(), options]);
        return { document: { uri: uri(shownUri) } };
      },
    },
  };
  return { calls, rootUri, vscode };
}

test("opens and confirms the exact requested workspace file", async () => {
  const { calls, rootUri, vscode } = fixture();

  assert.deepEqual(await openWorkspaceFile(vscode, rootUri, "src/index.ts"), {
    relativePath: "src/index.ts",
  });
  assert.deepEqual(calls, [
    ["open", "file:///repo/src/index.ts"],
    [
      "show",
      "file:///repo/src/index.ts",
      { preserveFocus: false, preview: true },
    ],
  ]);
});

test("rejects escaping and non-canonical requested paths", async () => {
  const { rootUri, vscode } = fixture();

  await assert.rejects(
    openWorkspaceFile(vscode, rootUri, "../outside.ts"),
    /worktree-relative/u,
  );
  await assert.rejects(
    openWorkspaceFile(vscode, rootUri, "./src/index.ts"),
    /worktree-relative/u,
  );
});

test("fails unless the requested file becomes the active editor", async () => {
  const { rootUri, vscode } = fixture({
    shownUri: "file:///repo/src/stale.ts",
  });

  await assert.rejects(
    openWorkspaceFile(vscode, rootUri, "src/index.ts"),
    /activated an unexpected file/u,
  );
});

test("uses the authenticated request root after configured-root tampering and reload", async () => {
  const { calls, rootUri, vscode } = fixture({
    workspaceFolderUris: ["file:///attacker", "file:///repo"],
  });
  vscode.workspace.getConfiguration = () => ({
    get: () => "file:///attacker",
  });
  let navigator = new WorkspaceFileNavigator(vscode);

  await assert.doesNotReject(navigator.open("src/index.ts", rootUri));
  navigator = new WorkspaceFileNavigator(vscode);
  await assert.doesNotReject(navigator.open("src/index.ts", rootUri));
  assert.deepEqual(
    calls.filter(([operation]) => operation === "open"),
    [
      ["open", "file:///repo/src/index.ts"],
      ["open", "file:///repo/src/index.ts"],
    ],
  );
});

test("rejects navigation after the authorized root is removed", async () => {
  const { calls, rootUri, vscode } = fixture();
  const navigator = new WorkspaceFileNavigator(vscode);
  vscode.workspace.workspaceFolders = [{ uri: uri("file:///attacker") }];

  await assert.rejects(
    navigator.open("src/index.ts", rootUri),
    /no longer matches its authorized root/u,
  );
  assert.deepEqual(calls, []);
});

test("rejects a derived target outside the immutable root", async () => {
  const { calls, rootUri, vscode } = fixture({
    joinedUri: "file:///attacker/index.ts",
  });

  await assert.rejects(
    openWorkspaceFile(vscode, rootUri, "src/index.ts"),
    /outside its workspace/u,
  );
  assert.deepEqual(calls, []);
});

test("serializes delayed file opens so the newest request is active last", async () => {
  let releaseFirst;
  const firstOpened = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const active = [];
  const vscode = {
    Uri: {
      joinPath(root, ...segments) {
        return uri(`${root.toString()}/${segments.join("/")}`);
      },
      parse: (value) => uri(value),
    },
    workspace: {
      workspaceFolders: [{ uri: uri("file:///repo") }],
      async openTextDocument(candidate) {
        if (candidate.toString().endsWith("/a.ts")) await firstOpened;
        return { uri: candidate };
      },
    },
    window: {
      async showTextDocument(document) {
        active.push(document.uri.toString());
        return { document };
      },
    },
  };
  const navigator = new WorkspaceFileNavigator(vscode);
  const first = navigator.open("a.ts", "file:///repo");
  const second = navigator.open("b.ts", "file:///repo");

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(active, []);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(active, ["file:///repo/a.ts", "file:///repo/b.ts"]);
});
