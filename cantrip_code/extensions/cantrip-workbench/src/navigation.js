"use strict";

const { safeRelativePaths } = require("./protocol.js");

function parseWorkspaceRoot(vscode, expectedWorkspaceRootUri) {
  if (
    typeof expectedWorkspaceRootUri !== "string" ||
    !expectedWorkspaceRootUri
  ) {
    throw new Error(
      "Cantrip Code requires a worker-authorized workspace root.",
    );
  }
  let root;
  try {
    root = vscode.Uri.parse(expectedWorkspaceRootUri, true);
  } catch {
    throw new Error("Cantrip Code rejected its configured workspace root.");
  }
  if (root.scheme !== "file" || root.query || root.fragment) {
    throw new Error("Cantrip Code rejected its configured workspace root.");
  }
  return root;
}

function uriBelongsToRoot(root, candidate) {
  const rootPath = root.path.endsWith("/") ? root.path.slice(0, -1) : root.path;
  return (
    candidate.scheme === root.scheme &&
    candidate.authority === root.authority &&
    candidate.query === "" &&
    candidate.fragment === "" &&
    candidate.path.startsWith(`${rootPath}/`)
  );
}

function tabResource(tab) {
  const candidate = tab?.input?.uri;
  return candidate && typeof candidate.toString === "function"
    ? candidate.toString()
    : null;
}

async function bounded(operation, timeoutMs, timeoutMessage) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(timeoutMessage)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function saveDirtyUnrelatedEditors(vscode, tabs, timeoutMs) {
  const documents = [
    ...(vscode.workspace.textDocuments ?? []),
    ...(vscode.workspace.notebookDocuments ?? []),
  ];
  const byUri = new Map(
    documents.map((document) => [document.uri.toString(), document]),
  );
  for (const tab of tabs) {
    if (!tab.isDirty) continue;
    const resource = tabResource(tab);
    const document = resource ? byUri.get(resource) : null;
    if (!document || document.uri.scheme !== "file") {
      throw new Error(
        "Cantrip Code cannot switch files while an unrelated untitled or custom editor has unsaved changes.",
      );
    }
    let saved;
    try {
      saved = await bounded(
        () => document.save(),
        timeoutMs,
        "Cantrip Code timed out while saving an unrelated editor.",
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cantrip Code could not save an unrelated editor before switching: ${reason}`,
      );
    }
    if (!saved) {
      throw new Error(
        "Cantrip Code could not save an unrelated editor before switching: the editor declined to save.",
      );
    }
  }
}

async function closeUnrelatedEditors(
  vscode,
  selectedUri,
  operationTimeoutMs = 2_000,
) {
  const tabGroups = vscode.window.tabGroups;
  if (!tabGroups) {
    throw new Error("Cantrip Code cannot inspect the open editor tabs.");
  }
  const groups = tabGroups.all ?? [];
  const entries = groups.flatMap((group) =>
    (group.tabs ?? []).map((tab) => ({ group, tab })),
  );
  const selected = selectedUri.toString();
  const keeper =
    entries.find(
      ({ group, tab }) =>
        group.isActive && tab.isActive && tabResource(tab) === selected,
    ) ??
    entries.find(({ tab }) => tab.isActive && tabResource(tab) === selected) ??
    entries.find(({ tab }) => tabResource(tab) === selected);
  if (!keeper) {
    throw new Error("Cantrip Code could not identify the selected editor tab.");
  }
  const unrelated = entries
    .filter((entry) => entry !== keeper)
    .map(({ tab }) => tab);
  await saveDirtyUnrelatedEditors(vscode, unrelated, operationTimeoutMs);
  if (unrelated.length) {
    const closed = await bounded(
      () => tabGroups.close(unrelated, true),
      operationTimeoutMs,
      "Cantrip Code timed out while closing unrelated editors.",
    );
    if (!closed) {
      throw new Error(
        "Cantrip Code could not close an unrelated editor. Save or discard its changes and try again.",
      );
    }
  }
  if (groups.length > 1) {
    await bounded(
      () => vscode.commands.executeCommand("workbench.action.joinAllGroups"),
      operationTimeoutMs,
      "Cantrip Code timed out while collapsing editor groups.",
    );
  }
  if (vscode.window.activeTextEditor?.document.uri.toString() !== selected) {
    throw new Error(
      "Cantrip Code lost the selected file while collapsing editor groups.",
    );
  }
}

async function openWorkspaceFile(
  vscode,
  expectedWorkspaceRootUri,
  requestedPath,
) {
  const workspaceRoot = parseWorkspaceRoot(vscode, expectedWorkspaceRootUri);
  const [relativePath] = safeRelativePaths([requestedPath]);
  if (!relativePath || relativePath !== requestedPath) {
    throw new Error("Cantrip Code requires a worktree-relative file path.");
  }
  const configuredRoot = workspaceRoot.toString();
  const rootIsPresent = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.toString() === configuredRoot,
  );
  if (!rootIsPresent) {
    throw new Error(
      "Cantrip Code workspace no longer matches its authorized root.",
    );
  }
  const uri = vscode.Uri.joinPath(workspaceRoot, ...relativePath.split("/"));
  if (!uriBelongsToRoot(workspaceRoot, uri)) {
    throw new Error("Cantrip Code rejected a file outside its workspace.");
  }
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.uri.toString() !== uri.toString()) {
    throw new Error("Cantrip Code resolved an unexpected file.");
  }
  const editor = await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: true,
  });
  if (editor.document.uri.toString() !== uri.toString()) {
    throw new Error("Cantrip Code activated an unexpected file.");
  }
  await closeUnrelatedEditors(vscode, uri);
  return { relativePath };
}

class WorkspaceFileNavigator {
  constructor(vscode) {
    this.vscode = vscode;
    this.tail = Promise.resolve();
  }

  open(requestedPath, expectedWorkspaceRootUri) {
    const operation = this.tail
      .catch(() => undefined)
      .then(() =>
        openWorkspaceFile(this.vscode, expectedWorkspaceRootUri, requestedPath),
      );
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

module.exports = {
  closeUnrelatedEditors,
  openWorkspaceFile,
  parseWorkspaceRoot,
  WorkspaceFileNavigator,
};
