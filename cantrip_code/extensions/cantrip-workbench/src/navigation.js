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
  if (
    root.scheme !== "file" ||
    root.query ||
    root.fragment ||
    root.toString() !== expectedWorkspaceRootUri
  ) {
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
  openWorkspaceFile,
  parseWorkspaceRoot,
  WorkspaceFileNavigator,
};
