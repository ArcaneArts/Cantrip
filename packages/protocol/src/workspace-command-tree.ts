import type { ProjectCenterLayoutNode } from "./project-tabs.js";

export function removeWorkspacePaneLeaf(
  node: ProjectCenterLayoutNode | null,
  paneId: string,
): ProjectCenterLayoutNode | null {
  if (!node) return null;
  if (node.kind === "pane") return node.paneId === paneId ? null : node;
  const first = removeWorkspacePaneLeaf(node.first, paneId);
  const second = removeWorkspacePaneLeaf(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function replaceWorkspacePaneLeaf(
  node: ProjectCenterLayoutNode,
  paneId: string,
  replacement: ProjectCenterLayoutNode,
): ProjectCenterLayoutNode {
  if (node.kind === "pane") return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    first: replaceWorkspacePaneLeaf(node.first, paneId, replacement),
    second: replaceWorkspacePaneLeaf(node.second, paneId, replacement),
  };
}

export function resizeWorkspaceSplit(
  node: ProjectCenterLayoutNode | null,
  splitId: string,
  fraction: number,
): boolean {
  if (!node || node.kind === "pane") return false;
  if (node.id === splitId) {
    node.fraction = fraction;
    return true;
  }
  return (
    resizeWorkspaceSplit(node.first, splitId, fraction) ||
    resizeWorkspaceSplit(node.second, splitId, fraction)
  );
}
