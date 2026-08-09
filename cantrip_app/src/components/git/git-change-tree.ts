import type { GitFileChange } from "@cantrip/protocol";

export type GitChangeTreeNode =
  | {
      type: "directory";
      name: string;
      path: string;
      children: GitChangeTreeNode[];
    }
  | {
      type: "file";
      name: string;
      path: string;
      change: GitFileChange;
    };

interface MutableDirectory {
  directories: Map<string, MutableDirectory>;
  files: Array<{ name: string; change: GitFileChange }>;
}

function sortNodes(nodes: GitChangeTreeNode[]): GitChangeTreeNode[] {
  return nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function materialize(
  directory: MutableDirectory,
  parentPath: string,
): GitChangeTreeNode[] {
  const nodes: GitChangeTreeNode[] = [];
  for (const [name, child] of directory.directories) {
    const childPath = parentPath ? `${parentPath}/${name}` : name;
    nodes.push({
      type: "directory",
      name,
      path: childPath,
      children: materialize(child, childPath),
    });
  }
  for (const { change, name } of directory.files) {
    nodes.push({ type: "file", name, path: change.path, change });
  }
  return sortNodes(nodes);
}

export function buildGitChangeTree(
  changes: GitFileChange[],
): GitChangeTreeNode[] {
  const root: MutableDirectory = { directories: new Map(), files: [] };
  for (const change of changes) {
    const segments = change.path.split("/").filter(Boolean);
    const fileName = segments.pop() ?? change.path;
    let directory = root;
    for (const segment of segments) {
      let child = directory.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), files: [] };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push({ name: fileName, change });
  }
  return materialize(root, "");
}
