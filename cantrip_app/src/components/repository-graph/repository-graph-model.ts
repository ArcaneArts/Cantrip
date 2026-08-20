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
const DEFAULT_RADIAL_GAP = 132;
const DEFAULT_NODE_GAP = 42;
const SPATIAL_CELL_SIZE = 96;
const FULL_CIRCLE = Math.PI * 2;
const RADIAL_START_ANGLE = -Math.PI / 2;

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

  // Allocate angular space from the outside in. A node's own diameter is part
  // of its subtree footprint, so larger metric-driven nodes widen their branch
  // instead of painting over their neighbours.
  const subtreeFootprints = new Map<string, number>();
  for (let index = traversal.length - 1; index >= 0; index -= 1) {
    const nodeId = traversal[index]!;
    const node = visibleById.get(nodeId);
    if (!node) continue;
    const ownFootprint = Math.max(
      nodeGap,
      boundedNodeRadius(node.radius) * 2 + nodeGap,
    );
    const childFootprint = (treeChildren.get(nodeId) ?? []).reduce(
      (total, child) => total + (subtreeFootprints.get(child.id) ?? nodeGap),
      0,
    );
    subtreeFootprints.set(nodeId, Math.max(ownFootprint, childFootprint));
  }

  const angles = new Map<string, number>();
  const sectors: Array<{ end: number; nodeId: string; start: number }> = [
    {
      end: RADIAL_START_ANGLE + FULL_CIRCLE,
      nodeId: rootId,
      start: RADIAL_START_ANGLE,
    },
  ];
  while (sectors.length > 0) {
    const sector = sectors.pop()!;
    angles.set(sector.nodeId, (sector.start + sector.end) / 2);
    const descendants = treeChildren.get(sector.nodeId) ?? [];
    if (descendants.length === 0) continue;
    const childFootprint = descendants.reduce(
      (total, child) => total + (subtreeFootprints.get(child.id) ?? nodeGap),
      0,
    );
    const parentFootprint = Math.max(
      childFootprint,
      subtreeFootprints.get(sector.nodeId) ?? childFootprint,
    );
    const extent = sector.end - sector.start;
    const usedExtent = extent * (childFootprint / parentFootprint);
    let cursor = sector.start + (extent - usedExtent) / 2;
    const childSectors: typeof sectors = [];
    for (const child of descendants) {
      const childExtent =
        extent *
        ((subtreeFootprints.get(child.id) ?? nodeGap) / parentFootprint);
      childSectors.push({
        end: cursor + childExtent,
        nodeId: child.id,
        start: cursor,
      });
      cursor += childExtent;
    }
    for (let index = childSectors.length - 1; index >= 0; index -= 1)
      sectors.push(childSectors[index]!);
  }

  const nodesByDepth = new Map<number, RepositoryGraphInputNode[]>();
  let maxDepth = 0;
  for (const nodeId of traversal) {
    const node = visibleById.get(nodeId);
    if (!node) continue;
    const depth = depthById.get(nodeId) ?? 0;
    maxDepth = Math.max(maxDepth, depth);
    const depthNodes = nodesByDepth.get(depth) ?? [];
    depthNodes.push(node);
    nodesByDepth.set(depth, depthNodes);
  }

  // Resolve collisions per ring. The chord between adjacent nodes must fit
  // both rendered radii plus the configured gap. Enlarging one node therefore
  // pushes the whole ring outward when its current circumference is too small.
  const ringRadii = new Array<number>(maxDepth + 1).fill(0);
  let previousMaximumNodeRadius = Math.max(
    0,
    ...(nodesByDepth.get(0) ?? []).map((node) =>
      boundedNodeRadius(node.radius),
    ),
  );
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const depthNodes = nodesByDepth.get(depth) ?? [];
    const maximumNodeRadius = Math.max(
      0,
      ...depthNodes.map((node) => boundedNodeRadius(node.radius)),
    );
    let collisionRadius = 0;
    if (depthNodes.length > 1) {
      const ordered = [...depthNodes].sort(
        (left, right) =>
          (angles.get(left.id) ?? 0) - (angles.get(right.id) ?? 0),
      );
      for (let index = 0; index < ordered.length; index += 1) {
        const current = ordered[index]!;
        const next = ordered[(index + 1) % ordered.length]!;
        const currentAngle = angles.get(current.id) ?? 0;
        const nextAngle = angles.get(next.id) ?? 0;
        const delta =
          (nextAngle - currentAngle + FULL_CIRCLE) % FULL_CIRCLE || FULL_CIRCLE;
        const chordFactor = 2 * Math.sin(delta / 2);
        if (chordFactor <= 0.000_001) continue;
        collisionRadius = Math.max(
          collisionRadius,
          (boundedNodeRadius(current.radius) +
            boundedNodeRadius(next.radius) +
            nodeGap) /
            chordFactor,
        );
      }
    }
    ringRadii[depth] = Math.max(
      collisionRadius,
      (ringRadii[depth - 1] ?? 0) +
        Math.max(
          radialGap,
          previousMaximumNodeRadius + maximumNodeRadius + nodeGap,
        ),
    );
    previousMaximumNodeRadius = maximumNodeRadius;
  }

  const positions = new Map<string, RepositoryGraphPoint & { depth: number }>();
  for (const nodeId of traversal) {
    const depth = depthById.get(nodeId) ?? 0;
    if (depth === 0) {
      positions.set(nodeId, { depth, x: 0, y: 0 });
      continue;
    }
    const angle = angles.get(nodeId) ?? RADIAL_START_ANGLE;
    const distance = ringRadii[depth] ?? depth * radialGap;
    positions.set(nodeId, {
      depth,
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
    });
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
    Math.max(18, options.nodeGap ?? DEFAULT_NODE_GAP),
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
