import type { ChatFileReferencesResult } from "@cantrip/protocol/surface-stream";

import { displayMarkdownFileReference } from "./markdown-file-link";
import type { MessageFileEntry } from "./message-file-summary";

export interface MessageFileTreeNode {
  children: MessageFileTreeNode[];
  entry: MessageFileEntry | null;
  kind: "directory" | "file";
  name: string;
  path: string;
}

function splitPath(value: string) {
  const normalized = displayMarkdownFileReference(value);
  const source = value.replaceAll("\\", "/");
  const anchor =
    source.match(/^[a-z]:\//iu)?.[0] ??
    source.match(/^\/\/[^/]+\/[^/]+\/?/u)?.[0].replace(/\/?$/u, "/") ??
    (source.startsWith("/") ? "/" : "");
  const parts: string[] = [];
  for (const part of normalized.slice(anchor.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return { anchor, parts };
}

function pathKey(value: string) {
  return /^[a-z]:\//iu.test(value) || value.startsWith("//")
    ? value.toLowerCase()
    : value;
}

function joinPath(anchor: string, parts: string[]) {
  return `${anchor}${parts.join("/")}` || ".";
}

export function messageFileTree(
  entries: readonly MessageFileEntry[],
  metadata?: ChatFileReferencesResult,
): MessageFileTreeNode | null {
  if (entries.length === 0) return null;
  const resolved = new Map(
    metadata?.entries.map((entry) => [entry.reference, entry]),
  );
  const paths = entries.map((entry) => {
    const reference = resolved.get(entry.reference);
    const value =
      reference?.path ??
      (metadata && !/^(?:\/|[a-z]:[\\/])/iu.test(entry.path)
        ? `${metadata.root}/${entry.path}`
        : entry.path);
    const location = splitPath(value);
    return {
      entry,
      ...location,
      directory:
        reference?.kind === "directory" || /[\\/]$/u.test(entry.reference),
    };
  });
  const parents = new Set(
    paths.flatMap(({ anchor, parts }) =>
      parts
        .slice(0, -1)
        .map((_, index) =>
          pathKey(joinPath(anchor, parts.slice(0, index + 1))),
        ),
    ),
  );
  for (const current of paths) {
    current.directory ||= parents.has(
      pathKey(joinPath(current.anchor, current.parts)),
    );
  }
  const anchor = paths[0]!.anchor;
  const sameAnchor = paths.every(
    (location) => pathKey(location.anchor) === pathKey(anchor),
  );
  let common = sameAnchor
    ? paths[0]!.parts.slice(0, paths[0]!.directory ? undefined : -1)
    : [];
  for (const location of paths.slice(1)) {
    const parent = location.parts.slice(0, location.directory ? undefined : -1);
    let length = 0;
    while (
      length < common.length &&
      length < parent.length &&
      pathKey(joinPath(anchor, [common[length]!])) ===
        pathKey(joinPath(location.anchor, [parent[length]!]))
    )
      length++;
    common = common.slice(0, length);
  }
  const root: MessageFileTreeNode = {
    children: [],
    entry: null,
    kind: "directory",
    name: sameAnchor ? joinPath(anchor, common) : "Referenced paths",
    path: sameAnchor ? joinPath(anchor, common) : "",
  };
  for (const location of paths) {
    let node = root;
    let depth = sameAnchor ? common.length : 0;
    if (!sameAnchor && location.anchor) {
      let branch = root.children.find(
        (child) => pathKey(child.path) === pathKey(location.anchor),
      );
      if (!branch) {
        branch = {
          children: [],
          entry: null,
          kind: "directory",
          name: location.anchor,
          path: location.anchor,
        };
        root.children.push(branch);
      }
      node = branch;
    }
    for (; depth < location.parts.length; depth++) {
      const nodePath = joinPath(
        location.anchor,
        location.parts.slice(0, depth + 1),
      );
      let child = node.children.find(
        (candidate) => pathKey(candidate.path) === pathKey(nodePath),
      );
      if (!child) {
        child = {
          children: [],
          entry: null,
          kind: "directory",
          name: location.parts[depth]!,
          path: nodePath,
        };
        node.children.push(child);
      }
      node = child;
    }
    node.entry = location.entry;
    node.kind =
      location.directory || node.children.length > 0 ? "directory" : "file";
  }
  const sort = (node: MessageFileTreeNode) => {
    if (node.children.length > 0) node.kind = "directory";
    node.children.forEach(sort);
    node.children.sort(
      (left, right) =>
        Number(right.kind === "directory") -
          Number(left.kind === "directory") ||
        left.name.localeCompare(right.name, undefined, { numeric: true }),
    );
  };
  sort(root);
  return root;
}

export function messageFileTreeCounts(node: MessageFileTreeNode): {
  files: number;
  folders: number;
} {
  return node.children.reduce(
    (count, child) => {
      const descendants = messageFileTreeCounts(child);
      return {
        files: count.files + descendants.files,
        folders: count.folders + descendants.folders,
      };
    },
    {
      files: node.entry && node.kind === "file" ? 1 : 0,
      folders: node.entry && node.kind === "directory" ? 1 : 0,
    },
  );
}
