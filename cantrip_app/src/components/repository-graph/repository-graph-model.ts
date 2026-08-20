export type RepositoryGraphPoint = {
  x: number;
  y: number;
};

export type RepositoryGraphBounds = {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
};

export type RepositoryGraphNodeKind =
  "directory" | "file" | "submodule" | "symlink" | "ghost";

export type RepositoryGraphInputNode = {
  accessibleDescription?: string;
  color: string;
  id: string;
  kind: RepositoryGraphNodeKind;
  label: string;
  parentId: string | null;
  path: string;
  radius: number;
};

export type RepositoryGraphSceneNode = RepositoryGraphInputNode & {
  aggregated: boolean;
  depth: number;
  hiddenDescendantCount: number;
  x: number;
  y: number;
};

export type RepositoryGraphSceneEdge = {
  from: RepositoryGraphPoint;
  id: string;
  parentId: string;
  to: RepositoryGraphPoint;
};

export type RepositoryGraphSpatialIndex = {
  cellSize: number;
  cells: ReadonlyMap<string, readonly number[]>;
};

export type RepositoryGraphScene = {
  bounds: RepositoryGraphBounds;
  edges: readonly RepositoryGraphSceneEdge[];
  hiddenNodeCount: number;
  nodes: readonly RepositoryGraphSceneNode[];
  nodesById: ReadonlyMap<string, RepositoryGraphSceneNode>;
  rootNodeId: string | null;
  spatialIndex: RepositoryGraphSpatialIndex;
  totalNodeCount: number;
};

export type BuildRepositoryGraphSceneOptions = {
  collapsedNodeIds?: ReadonlySet<string>;
  maxVisibleNodes?: number;
  nodeGap?: number;
  radialGap?: number;
  rootNodeId?: string | null;
};

const DEFAULT_MAX_VISIBLE_NODES = 4_000;
const DEFAULT_RADIAL_GAP = 96;
const DEFAULT_NODE_GAP = 16;
const SPATIAL_CELL_SIZE = 96;
const FULL_CIRCLE = Math.PI * 2;
const RADIAL_START_ANGLE = -Math.PI / 2;
const MAX_BRANCH_ANGLE = Math.PI * 0.8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function compareNodes(
  left: RepositoryGraphInputNode,
  right: RepositoryGraphInputNode,
): number {
  if (left.kind === "directory" && right.kind !== "directory") return -1;
  if (right.kind === "directory" && left.kind !== "directory") return 1;
  return left.label.localeCompare(right.label, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function boundedNodeRadius(radius: number): number {
  return Math.max(2, Math.min(32, radius));
}

type LocalNodePacking = {
  offsets: ReadonlyMap<string, RepositoryGraphPoint>;
  radius: number;
};

function packLocalNodes(
  nodes: readonly RepositoryGraphInputNode[],
  centerRadius: number,
  nodeGap: number,
): LocalNodePacking {
  const offsets = new Map<string, RepositoryGraphPoint>();
  let nextNode = 0;
  let previousOuterRadius = centerRadius;
  let ringIndex = 0;

  while (nextNode < nodes.length) {
    const ring: RepositoryGraphInputNode[] = [];
    let ringFootprint = 0;
    let ringMaximumRadius = 0;

    while (nextNode < nodes.length) {
      const candidate = nodes[nextNode]!;
      const candidateRadius = boundedNodeRadius(candidate.radius);
      const nextMaximumRadius = Math.max(ringMaximumRadius, candidateRadius);
      const provisionalRingRadius =
        previousOuterRadius + nodeGap + nextMaximumRadius;
      const nextFootprint = ringFootprint + candidateRadius * 2 + nodeGap;
      if (
        ring.length > 0 &&
        nextFootprint > FULL_CIRCLE * provisionalRingRadius
      ) {
        break;
      }
      ring.push(candidate);
      ringFootprint = nextFootprint;
      ringMaximumRadius = nextMaximumRadius;
      nextNode += 1;
    }

    const angularExtents = ring.map(
      (node) =>
        FULL_CIRCLE *
        ((boundedNodeRadius(node.radius) * 2 + nodeGap) / ringFootprint),
    );
    const angles: number[] = [];
    let angleCursor = RADIAL_START_ANGLE + ringIndex * GOLDEN_ANGLE;
    for (const extent of angularExtents) {
      angles.push(angleCursor + extent / 2);
      angleCursor += extent;
    }

    let ringRadius = previousOuterRadius + nodeGap + ringMaximumRadius;
    if (ring.length > 1) {
      for (let index = 0; index < ring.length; index += 1) {
        const nextIndex = (index + 1) % ring.length;
        const delta =
          (angles[nextIndex]! - angles[index]! + FULL_CIRCLE) % FULL_CIRCLE ||
          FULL_CIRCLE;
        const chordFactor = 2 * Math.sin(delta / 2);
        if (chordFactor <= 0.000_001) continue;
        ringRadius = Math.max(
          ringRadius,
          (boundedNodeRadius(ring[index]!.radius) +
            boundedNodeRadius(ring[nextIndex]!.radius) +
            nodeGap) /
            chordFactor,
        );
      }
    }

    ring.forEach((node, index) => {
      const angle = angles[index]!;
      offsets.set(node.id, {
        x: Math.cos(angle) * ringRadius,
        y: Math.sin(angle) * ringRadius,
      });
    });
    previousOuterRadius = ringRadius + ringMaximumRadius;
    ringIndex += 1;
  }

  return { offsets, radius: previousOuterRadius };
}

function emptyScene(totalNodeCount = 0): RepositoryGraphScene {
  return {
    bounds: { maxX: 1, maxY: 1, minX: -1, minY: -1 },
    edges: [],
    hiddenNodeCount: totalNodeCount,
    nodes: [],
    nodesById: new Map(),
    rootNodeId: null,
    spatialIndex: { cellSize: SPATIAL_CELL_SIZE, cells: new Map() },
    totalNodeCount,
  };
}

function collectDescendantCounts(
  rootId: string,
  childrenByParent: ReadonlyMap<string, readonly RepositoryGraphInputNode[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const discovered = new Set([rootId]);
  const stack: Array<{ expanded: boolean; nodeId: string }> = [
    { expanded: false, nodeId: rootId },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.expanded) {
      const descendants = (childrenByParent.get(current.nodeId) ?? []).reduce(
        (total, child) =>
          discovered.has(child.id)
            ? total + 1 + (counts.get(child.id) ?? 0)
            : total,
        0,
      );
      counts.set(current.nodeId, descendants);
      continue;
    }
    stack.push({ expanded: true, nodeId: current.nodeId });
    const children = childrenByParent.get(current.nodeId) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      if (discovered.has(child.id)) continue;
      discovered.add(child.id);
      stack.push({ expanded: false, nodeId: child.id });
    }
  }
  return counts;
}

function visibleBreadthFirst(
  root: RepositoryGraphInputNode,
  childrenByParent: ReadonlyMap<string, readonly RepositoryGraphInputNode[]>,
  collapsedNodeIds: ReadonlySet<string>,
  maxVisibleNodes: number,
): RepositoryGraphInputNode[] {
  const visible = [root];
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    if (visible.length >= maxVisibleNodes) break;
    const directory = directories[index]!;
    if (collapsedNodeIds.has(directory.id)) continue;
    for (const child of childrenByParent.get(directory.id) ?? []) {
      if (visible.length >= maxVisibleNodes) break;
      visible.push(child);
      if (child.kind === "directory") directories.push(child);
    }
  }
  return visible;
}

function layoutVisibleNodes(
  visible: readonly RepositoryGraphInputNode[],
  rootId: string,
  radialGap: number,
  nodeGap: number,
): Map<string, RepositoryGraphPoint & { depth: number }> {
  const visibleById = new Map(visible.map((node) => [node.id, node]));
  const visibleIds = new Set(visible.map((node) => node.id));
  const children = new Map<string, RepositoryGraphInputNode[]>();
  for (const node of visible) {
    if (!node.parentId || !visibleIds.has(node.parentId)) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareNodes);

  const depthById = new Map<string, number>([[rootId, 0]]);
  const treeChildren = new Map<string, RepositoryGraphInputNode[]>();
  const traversal: string[] = [];
  const discovered = new Set([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    traversal.push(nodeId);
    const descendants = children.get(nodeId) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      const child = descendants[index]!;
      if (discovered.has(child.id)) continue;
      discovered.add(child.id);
      depthById.set(child.id, (depthById.get(nodeId) ?? 0) + 1);
      const treeSiblings = treeChildren.get(nodeId) ?? [];
      treeSiblings.push(child);
      treeChildren.set(nodeId, treeSiblings);
      stack.push(child.id);
    }
  }
  for (const siblings of treeChildren.values()) siblings.sort(compareNodes);

  // Files orbit their immediate directory instead of sharing one repository-
  // wide depth ring. Their rendered radii participate in the packing, so a
  // large metric node physically displaces its local neighbours.
  const localPackings = new Map<string, LocalNodePacking>();
  const directoryChildren = new Map<string, RepositoryGraphInputNode[]>();
  for (const nodeId of traversal) {
    const node = visibleById.get(nodeId);
    if (!node) continue;
    const descendants = treeChildren.get(nodeId) ?? [];
    const directories = descendants.filter(
      (child) => child.kind === "directory",
    );
    const localNodes = descendants.filter(
      (child) => child.kind !== "directory",
    );
    directoryChildren.set(nodeId, directories);
    localPackings.set(
      nodeId,
      packLocalNodes(localNodes, boundedNodeRadius(node.radius), nodeGap),
    );
  }

  // A branch's angular footprint is the larger of its own local cluster and
  // all child directory branches. This keeps sibling subtrees in separate
  // sectors without forcing every leaf onto the same global circumference.
  const subtreeFootprints = new Map<string, number>();
  for (let index = traversal.length - 1; index >= 0; index -= 1) {
    const nodeId = traversal[index]!;
    const node = visibleById.get(nodeId);
    if (!node) continue;
    const ownFootprint =
      (localPackings.get(nodeId)?.radius ?? boundedNodeRadius(node.radius)) *
        2 +
      nodeGap;
    const childFootprint = (directoryChildren.get(nodeId) ?? []).reduce(
      (total, child) => total + (subtreeFootprints.get(child.id) ?? nodeGap),
      0,
    );
    subtreeFootprints.set(nodeId, Math.max(ownFootprint, childFootprint));
  }

  const positions = new Map<string, RepositoryGraphPoint & { depth: number }>([
    [rootId, { depth: 0, x: 0, y: 0 }],
  ]);
  const sectors: Array<{ end: number; nodeId: string; start: number }> = [
    {
      end: RADIAL_START_ANGLE + FULL_CIRCLE,
      nodeId: rootId,
      start: RADIAL_START_ANGLE,
    },
  ];
  while (sectors.length > 0) {
    const sector = sectors.pop()!;
    const descendants = directoryChildren.get(sector.nodeId) ?? [];
    if (descendants.length === 0) continue;
    const parentPosition = positions.get(sector.nodeId);
    if (!parentPosition) continue;
    const childFootprint = descendants.reduce(
      (total, child) => total + (subtreeFootprints.get(child.id) ?? nodeGap),
      0,
    );
    const originalExtent = sector.end - sector.start;
    const branchExtent =
      sector.nodeId === rootId
        ? originalExtent
        : Math.min(originalExtent, MAX_BRANCH_ANGLE);
    const branchMiddle = (sector.start + sector.end) / 2;
    let cursor = branchMiddle - branchExtent / 2;
    const childSectors: Array<{
      angle: number;
      end: number;
      node: RepositoryGraphInputNode;
      start: number;
    }> = [];
    for (const child of descendants) {
      const childExtent =
        branchExtent *
        ((subtreeFootprints.get(child.id) ?? nodeGap) / childFootprint);
      childSectors.push({
        angle: cursor + childExtent / 2,
        end: cursor + childExtent,
        node: child,
        start: cursor,
      });
      cursor += childExtent;
    }
    const parentLocalRadius =
      localPackings.get(sector.nodeId)?.radius ?? nodeGap;
    const maximumChildLocalRadius = Math.max(
      0,
      ...descendants.map(
        (child) => localPackings.get(child.id)?.radius ?? nodeGap,
      ),
    );
    let branchRadius = Math.max(
      parentLocalRadius + maximumChildLocalRadius + radialGap,
      childFootprint / Math.max(0.25, branchExtent),
    );
    if (childSectors.length > 1) {
      const pairCount =
        branchExtent >= FULL_CIRCLE - 0.000_001
          ? childSectors.length
          : childSectors.length - 1;
      for (let index = 0; index < pairCount; index += 1) {
        const current = childSectors[index]!;
        const next = childSectors[(index + 1) % childSectors.length]!;
        const delta =
          (next.angle - current.angle + FULL_CIRCLE) % FULL_CIRCLE ||
          FULL_CIRCLE;
        const chordFactor = 2 * Math.sin(delta / 2);
        if (chordFactor <= 0.000_001) continue;
        branchRadius = Math.max(
          branchRadius,
          ((localPackings.get(current.node.id)?.radius ?? nodeGap) +
            (localPackings.get(next.node.id)?.radius ?? nodeGap) +
            nodeGap) /
            chordFactor,
        );
      }
    }

    for (let index = childSectors.length - 1; index >= 0; index -= 1) {
      const childSector = childSectors[index]!;
      positions.set(childSector.node.id, {
        depth: depthById.get(childSector.node.id) ?? parentPosition.depth + 1,
        x: parentPosition.x + Math.cos(childSector.angle) * branchRadius,
        y: parentPosition.y + Math.sin(childSector.angle) * branchRadius,
      });
      sectors.push({
        end: childSector.end,
        nodeId: childSector.node.id,
        start: childSector.start,
      });
    }
  }

  // Translate each local file orbit once its directory center is known.
  for (const nodeId of traversal) {
    const parentPosition = positions.get(nodeId);
    if (!parentPosition) continue;
    for (const [childId, offset] of localPackings.get(nodeId)?.offsets ?? []) {
      positions.set(childId, {
        depth: depthById.get(childId) ?? parentPosition.depth + 1,
        x: parentPosition.x + offset.x,
        y: parentPosition.y + offset.y,
      });
    }
  }
  return positions;
}

function buildSpatialIndex(
  nodes: readonly RepositoryGraphSceneNode[],
): RepositoryGraphSpatialIndex {
  const cells = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    const reach = Math.max(12, node.radius);
    const minCellX = Math.floor((node.x - reach) / SPATIAL_CELL_SIZE);
    const maxCellX = Math.floor((node.x + reach) / SPATIAL_CELL_SIZE);
    const minCellY = Math.floor((node.y - reach) / SPATIAL_CELL_SIZE);
    const maxCellY = Math.floor((node.y + reach) / SPATIAL_CELL_SIZE);
    for (let x = minCellX; x <= maxCellX; x += 1) {
      for (let y = minCellY; y <= maxCellY; y += 1) {
        const key = cellKey(x, y);
        const bucket = cells.get(key) ?? [];
        bucket.push(index);
        cells.set(key, bucket);
      }
    }
  });
  return { cellSize: SPATIAL_CELL_SIZE, cells };
}

export function buildRepositoryGraphScene(
  inputNodes: readonly RepositoryGraphInputNode[],
  options: BuildRepositoryGraphSceneOptions = {},
): RepositoryGraphScene {
  if (inputNodes.length === 0) return emptyScene();

  const inputById = new Map(inputNodes.map((node) => [node.id, node]));
  const requestedRoot = options.rootNodeId
    ? inputById.get(options.rootNodeId)
    : undefined;
  const root =
    requestedRoot ??
    inputNodes.find((node) => node.parentId === null) ??
    inputNodes[0];
  if (!root) return emptyScene(inputNodes.length);

  const childrenByParent = new Map<string, RepositoryGraphInputNode[]>();
  for (const node of inputNodes) {
    if (!node.parentId || !inputById.has(node.parentId)) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort(compareNodes);

  const descendants = collectDescendantCounts(root.id, childrenByParent);
  const maxVisibleNodes = Math.max(
    1,
    Math.floor(options.maxVisibleNodes ?? DEFAULT_MAX_VISIBLE_NODES),
  );
  const visible = visibleBreadthFirst(
    root,
    childrenByParent,
    options.collapsedNodeIds ?? new Set(),
    maxVisibleNodes,
  );
  const visibleIds = new Set(visible.map((node) => node.id));
  const visibleChildren = new Map<string, RepositoryGraphInputNode[]>();
  for (const [parentId, children] of childrenByParent) {
    if (!visibleIds.has(parentId)) continue;
    visibleChildren.set(
      parentId,
      children.filter((node) => visibleIds.has(node.id)),
    );
  }
  const visibleDescendants = collectDescendantCounts(root.id, visibleChildren);

  const positions = layoutVisibleNodes(
    visible,
    root.id,
    Math.max(24, options.radialGap ?? DEFAULT_RADIAL_GAP),
    Math.max(8, options.nodeGap ?? DEFAULT_NODE_GAP),
  );
  const sceneNodes: RepositoryGraphSceneNode[] = [];
  const nodesById = new Map<string, RepositoryGraphSceneNode>();
  for (const node of visible) {
    const position = positions.get(node.id);
    if (!position) continue;
    const hiddenDescendantCount = Math.max(
      0,
      (descendants.get(node.id) ?? 0) - (visibleDescendants.get(node.id) ?? 0),
    );
    const sceneNode: RepositoryGraphSceneNode = {
      ...node,
      aggregated: hiddenDescendantCount > 0,
      depth: position.depth,
      hiddenDescendantCount,
      radius: boundedNodeRadius(node.radius),
      x: position.x,
      y: position.y,
    };
    sceneNodes.push(sceneNode);
    nodesById.set(sceneNode.id, sceneNode);
  }

  const edges: RepositoryGraphSceneEdge[] = [];
  for (const node of sceneNodes) {
    if (!node.parentId) continue;
    const parent = nodesById.get(node.parentId);
    if (!parent) continue;
    edges.push({
      from: { x: parent.x, y: parent.y },
      id: `${parent.id}->${node.id}`,
      parentId: parent.id,
      to: { x: node.x, y: node.y },
    });
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of sceneNodes) {
    const reach = Math.max(node.radius, 12);
    minX = Math.min(minX, node.x - reach);
    minY = Math.min(minY, node.y - reach);
    maxX = Math.max(maxX, node.x + reach);
    maxY = Math.max(maxY, node.y + reach);
  }

  return {
    bounds: { maxX, maxY, minX, minY },
    edges,
    hiddenNodeCount: Math.max(
      0,
      (descendants.get(root.id) ?? 0) + 1 - sceneNodes.length,
    ),
    nodes: sceneNodes,
    nodesById,
    rootNodeId: root.id,
    spatialIndex: buildSpatialIndex(sceneNodes),
    totalNodeCount: (descendants.get(root.id) ?? 0) + 1,
  };
}

export function queryRepositoryGraphNodes(
  scene: RepositoryGraphScene,
  bounds: RepositoryGraphBounds,
): RepositoryGraphSceneNode[] {
  const { cellSize, cells } = scene.spatialIndex;
  const minCellX = Math.floor(bounds.minX / cellSize);
  const maxCellX = Math.floor(bounds.maxX / cellSize);
  const minCellY = Math.floor(bounds.minY / cellSize);
  const maxCellY = Math.floor(bounds.maxY / cellSize);
  const indices = new Set<number>();
  for (let x = minCellX; x <= maxCellX; x += 1) {
    for (let y = minCellY; y <= maxCellY; y += 1) {
      for (const index of cells.get(cellKey(x, y)) ?? []) indices.add(index);
    }
  }
  return [...indices]
    .map((index) => scene.nodes[index])
    .filter((node): node is RepositoryGraphSceneNode => {
      if (!node) return false;
      return (
        node.x + node.radius >= bounds.minX &&
        node.x - node.radius <= bounds.maxX &&
        node.y + node.radius >= bounds.minY &&
        node.y - node.radius <= bounds.maxY
      );
    });
}

export function hitTestRepositoryGraph(
  scene: RepositoryGraphScene,
  point: RepositoryGraphPoint,
  minimumRadius = 10,
): RepositoryGraphSceneNode | null {
  const reach = Math.max(1, minimumRadius);
  const candidates = queryRepositoryGraphNodes(scene, {
    maxX: point.x + reach,
    maxY: point.y + reach,
    minX: point.x - reach,
    minY: point.y - reach,
  });
  let closest: RepositoryGraphSceneNode | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const node of candidates) {
    const distance = Math.hypot(point.x - node.x, point.y - node.y);
    if (
      distance <= Math.max(minimumRadius, node.radius) &&
      distance < closestDistance
    ) {
      closest = node;
      closestDistance = distance;
    }
  }
  return closest;
}
