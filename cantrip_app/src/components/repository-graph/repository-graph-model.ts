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
  horizontalGap?: number;
  maxVisibleNodes?: number;
  rootNodeId?: string | null;
  verticalGap?: number;
};

const DEFAULT_MAX_VISIBLE_NODES = 4_000;
const DEFAULT_HORIZONTAL_GAP = 132;
const DEFAULT_VERTICAL_GAP = 42;
const SPATIAL_CELL_SIZE = 96;

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
  horizontalGap: number,
  verticalGap: number,
): Map<string, RepositoryGraphPoint & { depth: number }> {
  const visibleIds = new Set(visible.map((node) => node.id));
  const children = new Map<string, RepositoryGraphInputNode[]>();
  for (const node of visible) {
    if (!node.parentId || !visibleIds.has(node.parentId)) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareNodes);

  const positions = new Map<string, RepositoryGraphPoint & { depth: number }>();
  const depthById = new Map<string, number>([[rootId, 0]]);
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
      stack.push(child.id);
    }
  }
  let nextLeaf = 0;
  for (const nodeId of traversal) {
    const descendants = (children.get(nodeId) ?? []).filter((child) =>
      discovered.has(child.id),
    );
    if (descendants.length > 0) continue;
    positions.set(nodeId, {
      depth: depthById.get(nodeId) ?? 0,
      x: (depthById.get(nodeId) ?? 0) * horizontalGap,
      y: nextLeaf * verticalGap,
    });
    nextLeaf += 1;
  }
  for (let index = traversal.length - 1; index >= 0; index -= 1) {
    const nodeId = traversal[index]!;
    if (positions.has(nodeId)) continue;
    const childPositions = (children.get(nodeId) ?? [])
      .map((child) => positions.get(child.id))
      .filter(
        (position): position is RepositoryGraphPoint & { depth: number } =>
          position !== undefined,
      );
    const slot = childPositions.length
      ? childPositions.reduce((total, child) => total + child.y, 0) /
        childPositions.length
      : nextLeaf++ * verticalGap;
    const depth = depthById.get(nodeId) ?? 0;
    positions.set(nodeId, { depth, x: depth * horizontalGap, y: slot });
  }

  const rootPosition = positions.get(rootId);
  if (rootPosition) {
    for (const position of positions.values()) position.y -= rootPosition.y;
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
    Math.max(24, options.horizontalGap ?? DEFAULT_HORIZONTAL_GAP),
    Math.max(18, options.verticalGap ?? DEFAULT_VERTICAL_GAP),
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
      radius: Math.max(2, Math.min(32, node.radius)),
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
