"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  closeUnrelatedEditors,
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
  closeResult = true,
  joinedUri,
  openTabUris = [],
  rootUri = "file:///repo",
  shownUri = "file:///repo/src/index.ts",
  workspaceFolderUris = ["file:///repo"],
} = {}) {
  const calls = [];
  const activeTab = {
    input: { uri: uri(shownUri) },
    isActive: true,
  };
  const unrelatedTabs = openTabUris.map((value) => ({
    input: { uri: uri(value) },
    isActive: false,
    isDirty: false,
  }));
  const group = {
    activeTab,
    isActive: true,
    tabs: [activeTab, ...unrelatedTabs],
  };
  const vscode = {
    commands: {
      async executeCommand(command) {
        calls.push(["command", command]);
      },
    },
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
      activeTextEditor: { document: { uri: uri(shownUri) } },
      tabGroups: {
        all: [group],
        async close(tabs, preserveFocus) {
          calls.push([
            "close",
            tabs.map((tab) => tab.input.uri.toString()),
            preserveFocus,
          ]);
          return closeResult;
        },
      },
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

test("collapses editor groups only when more than one group exists", async () => {
  const { calls, rootUri, vscode } = fixture();
  vscode.window.tabGroups.all.push({
    activeTab: undefined,
    isActive: false,
    tabs: [],
  });

  await openWorkspaceFile(vscode, rootUri, "src/index.ts");

  assert.deepEqual(calls.at(-1), ["command", "workbench.action.joinAllGroups"]);
});

test("closes clean restored and unrelated editor tabs", async () => {
  const { calls, rootUri, vscode } = fixture({
    openTabUris: ["file:///repo/README.md", "file:///repo/src/previous.ts"],
  });

  await openWorkspaceFile(vscode, rootUri, "src/index.ts");

  assert.deepEqual(calls.at(-1), [
    "close",
    ["file:///repo/README.md", "file:///repo/src/previous.ts"],
    true,
  ]);
});

test("saves a dirty file-backed editor before switching to the exact new file", async () => {
  const { calls, rootUri, vscode } = fixture({
    openTabUris: ["file:///repo/src/dirty.ts"],
  });
  vscode.window.tabGroups.all[0].tabs[1].isDirty = true;
  let saved = 0;
  vscode.workspace.textDocuments = [
    {
      uri: uri("file:///repo/src/dirty.ts"),
      async save() {
        saved += 1;
        return true;
      },
    },
  ];

  await assert.doesNotReject(
    openWorkspaceFile(vscode, rootUri, "src/index.ts"),
  );
  assert.equal(saved, 1);
  assert.deepEqual(calls.at(-1), [
    "close",
    ["file:///repo/src/dirty.ts"],
    true,
  ]);
});

test("fails without discarding an unrelated dirty editor that cannot be saved", async () => {
  const { calls, rootUri, vscode } = fixture({
    openTabUris: ["untitled:Untitled-1"],
  });
  vscode.window.tabGroups.all[0].tabs[1].isDirty = true;

  await assert.rejects(
    openWorkspaceFile(vscode, rootUri, "src/index.ts"),
    /untitled or custom editor/u,
  );
  assert.equal(
    calls.some(([operation]) => operation === "close"),
    false,
  );
});

test("fails instead of reporting ready when clean unrelated tabs do not close", async () => {
  const { rootUri, vscode } = fixture({
    closeResult: false,
    openTabUris: ["file:///repo/src/previous.ts"],
  });

  await assert.rejects(
    openWorkspaceFile(vscode, rootUri, "src/index.ts"),
    /could not close an unrelated editor/u,
  );
});

test("bounds a clean-tab close that stops responding", async () => {
  const { vscode } = fixture({
    openTabUris: ["file:///repo/src/previous.ts"],
  });
  vscode.window.tabGroups.close = () => new Promise(() => {});

  await assert.rejects(
    closeUnrelatedEditors(vscode, uri("file:///repo/src/index.ts"), 5),
    /timed out while closing unrelated editors/u,
  );
});

test("bounds an editor-group collapse that stops responding", async () => {
  const { vscode } = fixture();
  vscode.window.tabGroups.all.push({
    activeTab: undefined,
    isActive: false,
    tabs: [],
  });
  vscode.commands.executeCommand = () => new Promise(() => {});

  await assert.rejects(
    Promise.race([
      closeUnrelatedEditors(vscode, uri("file:///repo/src/index.ts"), 5),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("navigation test did not settle")),
          25,
        ),
      ),
    ]),
    /timed out while collapsing editor groups/u,
  );
});

test("fails when collapsing editor groups changes the selected active file", async () => {
  const { rootUri, vscode } = fixture();
  vscode.window.tabGroups.all.push({
    activeTab: undefined,
    isActive: false,
    tabs: [],
  });
  vscode.commands.executeCommand = async () => {
    vscode.window.activeTextEditor = {
      document: { uri: uri("file:///repo/src/stale.ts") },
    };
  };

  await assert.rejects(
    openWorkspaceFile(vscode, rootUri, "src/index.ts"),
    /lost the selected file/u,
  );
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
  const group = { activeTab: undefined, isActive: true, tabs: [] };
  const vscode = {
    commands: {
      async executeCommand() {},
    },
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
      tabGroups: {
        all: [group],
        async close() {
          return true;
        },
      },
      async showTextDocument(document) {
        active.push(document.uri.toString());
        const tab = {
          input: { uri: document.uri },
          isActive: true,
          isDirty: false,
        };
        group.activeTab = tab;
        group.tabs = [tab];
        vscode.window.activeTextEditor = { document };
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
