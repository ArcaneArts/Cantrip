import type {
  ProjectCenterLayoutNode,
  ProjectPaneMemberSplit,
} from "@cantrip/protocol";

export type CenterLayoutNode = ProjectCenterLayoutNode;
export type CenterSplitDirection = Extract<
  ProjectCenterLayoutNode,
  { kind: "split" }
>["direction"];
export type CenterPaneEdge = ProjectPaneMemberSplit["edge"];

export const DEFAULT_CENTER_SPLIT_FRACTION = 0.5;
export const MIN_CENTER_SPLIT_FRACTION = 0.1;
export const MAX_CENTER_SPLIT_FRACTION = 0.9;

export function clampCenterSplitFraction(fraction: number): number {
  return Math.max(
    MIN_CENTER_SPLIT_FRACTION,
    Math.min(MAX_CENTER_SPLIT_FRACTION, fraction),
  );
}

export function centerSplitDirectionForEdge(
  edge: CenterPaneEdge,
): CenterSplitDirection {
  return edge === "left" || edge === "right" ? "horizontal" : "vertical";
}

export function centerSplitPlacesNewPaneFirst(edge: CenterPaneEdge): boolean {
  return edge === "left" || edge === "top";
}

export function centerLayoutPaneIds(
  root: CenterLayoutNode | null | undefined,
): string[] {
  if (!root) return [];
  if (root.kind === "pane") return [root.paneId];
  return [
    ...centerLayoutPaneIds(root.first),
    ...centerLayoutPaneIds(root.second),
  ];
}

/**
 * Mixed-version layouts may omit the split tree. Give every historical pane
 * a deterministic local topology until the server returns a durable tree.
 */
export function resolvedCenterLayoutRoot({
  centerPaneIds,
  preferredPaneId,
  root,
}: {
  centerPaneIds: readonly string[];
  preferredPaneId?: string | null;
  root: CenterLayoutNode | null | undefined;
}): CenterLayoutNode | null {
  const available = new Set(centerPaneIds);
  if (root === null) return null;
  if (root === undefined) {
    return centerPaneIds.reduceRight<CenterLayoutNode | null>(
      (second, paneId, index) =>
        second
          ? {
              kind: "split",
              id: `legacy-center-split:${index}:${paneId}`,
              direction: "horizontal",
              fraction: DEFAULT_CENTER_SPLIT_FRACTION,
              first: { kind: "pane", paneId },
              second,
            }
          : { kind: "pane", paneId },
      null,
    );
  }
  const normalized = normalizeCenterLayoutRoot(root, available);
  if (normalized) return normalized;
  const fallback =
    (preferredPaneId && available.has(preferredPaneId)
      ? preferredPaneId
      : centerPaneIds[0]) ?? null;
  return fallback ? { kind: "pane", paneId: fallback } : null;
}

function normalizeCenterLayoutRoot(
  node: CenterLayoutNode | null | undefined,
  available: ReadonlySet<string>,
): CenterLayoutNode | null {
  if (!node) return null;
  if (node.kind === "pane") {
    return available.has(node.paneId) ? node : null;
  }
  const first = normalizeCenterLayoutRoot(node.first, available);
  const second = normalizeCenterLayoutRoot(node.second, available);
  if (!first) return second;
  if (!second) return first;
  return {
    ...node,
    fraction: clampCenterSplitFraction(node.fraction),
    first,
    second,
  };
}

export function replaceCenterSplitFraction(
  root: CenterLayoutNode,
  splitId: string,
  fraction: number,
): CenterLayoutNode {
  if (root.kind === "pane") return root;
  if (root.id === splitId) {
    const next = clampCenterSplitFraction(fraction);
    return next === root.fraction ? root : { ...root, fraction: next };
  }
  const first = replaceCenterSplitFraction(root.first, splitId, fraction);
  const second = replaceCenterSplitFraction(root.second, splitId, fraction);
  return first === root.first && second === root.second
    ? root
    : { ...root, first, second };
}

export function removeCenterPaneFromRoot(
  root: CenterLayoutNode | null,
  paneId: string,
): CenterLayoutNode | null {
  if (!root) return null;
  if (root.kind === "pane") return root.paneId === paneId ? null : root;
  const first = removeCenterPaneFromRoot(root.first, paneId);
  const second = removeCenterPaneFromRoot(root.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === root.first && second === root.second
    ? root
    : { ...root, first, second };
}

export function appendCenterPaneToRoot(
  root: CenterLayoutNode | null,
  paneId: string,
  splitId: string,
): CenterLayoutNode {
  const pane = { kind: "pane", paneId } as const;
  return root
    ? {
        kind: "split",
        id: splitId,
        direction: "horizontal",
        fraction: DEFAULT_CENTER_SPLIT_FRACTION,
        first: root,
        second: pane,
      }
    : pane;
}

export function replaceCenterLeafOrder(
  root: CenterLayoutNode,
  paneIds: readonly string[],
): CenterLayoutNode {
  let index = 0;
  const visit = (node: CenterLayoutNode): CenterLayoutNode => {
    if (node.kind === "pane") {
      const paneId = paneIds[index++];
      return paneId && paneId !== node.paneId ? { kind: "pane", paneId } : node;
    }
    const first = visit(node.first);
    const second = visit(node.second);
    return first === node.first && second === node.second
      ? node
      : { ...node, first, second };
  };
  return visit(root);
}

export function splitCenterPaneRoot(
  root: CenterLayoutNode,
  input: {
    edge: CenterPaneEdge;
    fraction: number;
    newPaneId: string;
    splitId: string;
    targetPaneId: string;
  },
): CenterLayoutNode {
  if (root.kind === "pane") {
    if (root.paneId !== input.targetPaneId) return root;
    const newPane = { kind: "pane", paneId: input.newPaneId } as const;
    const newFirst = centerSplitPlacesNewPaneFirst(input.edge);
    return {
      kind: "split",
      id: input.splitId,
      direction: centerSplitDirectionForEdge(input.edge),
      fraction: clampCenterSplitFraction(input.fraction),
      first: newFirst ? newPane : root,
      second: newFirst ? root : newPane,
    };
  }
  const first = splitCenterPaneRoot(root.first, input);
  const second = splitCenterPaneRoot(root.second, input);
  return first === root.first && second === root.second
    ? root
    : { ...root, first, second };
}

export function centerSplitFractionForKey(
  direction: CenterSplitDirection,
  fraction: number,
  key: string,
): number | null {
  if (key === "Home") return MIN_CENTER_SPLIT_FRACTION;
  if (key === "End") return MAX_CENTER_SPLIT_FRACTION;
  if (key === "Enter" || key === " ") return DEFAULT_CENTER_SPLIT_FRACTION;
  const delta =
    direction === "horizontal"
      ? key === "ArrowLeft"
        ? -0.05
        : key === "ArrowRight"
          ? 0.05
          : null
      : key === "ArrowUp"
        ? -0.05
        : key === "ArrowDown"
          ? 0.05
          : null;
  return delta === null ? null : clampCenterSplitFraction(fraction + delta);
}
