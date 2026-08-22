import {
  repositoryGraphViewportWorldBounds,
  repositoryGraphWorldToScreen,
  type RepositoryGraphCamera,
  type RepositoryGraphViewport,
} from "./repository-graph-camera";
import {
  queryRepositoryGraphNodes,
  type RepositoryGraphScene,
  type RepositoryGraphSceneEdge,
  type RepositoryGraphSceneNode,
} from "./repository-graph-model";

export type RepositoryGraphCanvasTheme = {
  background: string;
  edge: string;
  foreground: string;
  muted: string;
  selection: string;
};

export type RepositoryGraphRenderOptions = {
  devicePixelRatio?: number;
  highContrast?: boolean;
  hoveredNodeId?: string | null;
  maxLabels?: number;
  selectedNodeId?: string | null;
  theme: RepositoryGraphCanvasTheme;
};

export type RepositoryGraphRenderPlan = {
  edges: readonly RepositoryGraphSceneEdge[];
  labels: readonly RepositoryGraphSceneNode[];
  nodes: readonly RepositoryGraphSceneNode[];
};

export interface RepositoryGraphRenderingAdapter {
  isSupported?(canvas: HTMLCanvasElement): boolean;
  render(
    canvas: HTMLCanvasElement,
    scene: RepositoryGraphScene,
    camera: RepositoryGraphCamera,
    viewport: RepositoryGraphViewport,
    options: RepositoryGraphRenderOptions,
  ): void;
}

type RepositoryGraphPlanOptions = Pick<
  RepositoryGraphRenderOptions,
  "hoveredNodeId" | "maxLabels" | "selectedNodeId"
>;

function normalizedLabelLimit(maxLabels: number | undefined): number {
  const requested = maxLabels ?? 120;
  if (Number.isNaN(requested) || requested <= 0) return 0;
  if (!Number.isFinite(requested)) return Number.MAX_SAFE_INTEGER;
  return Math.floor(requested);
}

function compareLabelNodes(
  left: RepositoryGraphSceneNode,
  right: RepositoryGraphSceneNode,
  selectedNodeId: string | null | undefined,
  hoveredNodeId: string | null | undefined,
): number {
  const leftSelected = left.id === selectedNodeId || left.id === hoveredNodeId;
  const rightSelected =
    right.id === selectedNodeId || right.id === hoveredNodeId;
  if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
  if (left.kind !== right.kind)
    return left.kind === "directory" ? -1 : right.kind === "directory" ? 1 : 0;
  return right.radius - left.radius;
}

function selectRepositoryGraphLabels(
  visible: readonly RepositoryGraphSceneNode[],
  cameraScale: number,
  options: RepositoryGraphPlanOptions,
): RepositoryGraphSceneNode[] {
  const limit = normalizedLabelLimit(options.maxLabels);
  if (limit === 0) return [];
  const labels: RepositoryGraphSceneNode[] = [];
  for (const node of visible) {
    if (
      node.id !== options.selectedNodeId &&
      node.id !== options.hoveredNodeId &&
      node.kind !== "directory" &&
      !node.aggregated &&
      node.radius * cameraScale < 7
    ) {
      continue;
    }
    let low = 0;
    let high = labels.length;
    // Upper-bound insertion retains Array.sort's stable ordering for ties.
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (
        compareLabelNodes(
          node,
          labels[middle]!,
          options.selectedNodeId,
          options.hoveredNodeId,
        ) < 0
      ) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    if (low >= limit && labels.length >= limit) continue;
    labels.splice(low, 0, node);
    if (labels.length > limit) labels.pop();
  }
  return labels;
}

function selectRepositoryGraphEdges(
  scene: RepositoryGraphScene,
  visible: readonly RepositoryGraphSceneNode[],
): RepositoryGraphSceneEdge[] {
  const edges: RepositoryGraphSceneEdge[] = [];
  const included = new Set<RepositoryGraphSceneEdge>();
  for (const node of visible) {
    for (const edge of scene.edgesByNodeId.get(node.id) ?? []) {
      if (included.has(edge)) continue;
      included.add(edge);
      edges.push(edge);
    }
  }
  return edges;
}

function planRepositoryGraphVisibleNodes(
  scene: RepositoryGraphScene,
  visible: readonly RepositoryGraphSceneNode[],
  cameraScale: number,
  options: RepositoryGraphPlanOptions,
): RepositoryGraphRenderPlan {
  return {
    edges: selectRepositoryGraphEdges(scene, visible),
    labels: selectRepositoryGraphLabels(visible, cameraScale, options),
    nodes: visible,
  };
}

export function createRepositoryGraphRenderPlan(
  scene: RepositoryGraphScene,
  camera: RepositoryGraphCamera,
  viewport: RepositoryGraphViewport,
  options: RepositoryGraphPlanOptions = {},
): RepositoryGraphRenderPlan {
  const visible = queryRepositoryGraphNodes(
    scene,
    repositoryGraphViewportWorldBounds(camera, viewport),
  );
  return planRepositoryGraphVisibleNodes(scene, visible, camera.scale, options);
}

function sameCamera(
  left: RepositoryGraphCamera | null,
  right: RepositoryGraphCamera,
): boolean {
  return (
    left?.centerX === right.centerX &&
    left.centerY === right.centerY &&
    left.rotation === right.rotation &&
    left.scale === right.scale
  );
}

function sameViewport(
  left: RepositoryGraphViewport | null,
  right: RepositoryGraphViewport,
): boolean {
  return left?.height === right.height && left.width === right.width;
}

function sameNodes(
  left: readonly RepositoryGraphSceneNode[],
  right: readonly RepositoryGraphSceneNode[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export class RepositoryGraphRenderPlanner {
  private camera: RepositoryGraphCamera | null = null;
  private hoveredNodeId: string | null = null;
  private maxLabels = 120;
  private plan: RepositoryGraphRenderPlan | null = null;
  private scale = Number.NaN;
  private scene: RepositoryGraphScene | null = null;
  private selectedNodeId: string | null = null;
  private viewport: RepositoryGraphViewport | null = null;

  create(
    scene: RepositoryGraphScene,
    camera: RepositoryGraphCamera,
    viewport: RepositoryGraphViewport,
    options: RepositoryGraphPlanOptions = {},
  ): RepositoryGraphRenderPlan {
    const geometryUnchanged =
      this.scene === scene &&
      sameCamera(this.camera, camera) &&
      sameViewport(this.viewport, viewport);
    let nodes: readonly RepositoryGraphSceneNode[];
    let edges: readonly RepositoryGraphSceneEdge[];
    if (geometryUnchanged && this.plan) {
      nodes = this.plan.nodes;
      edges = this.plan.edges;
    } else {
      const visible = queryRepositoryGraphNodes(
        scene,
        repositoryGraphViewportWorldBounds(camera, viewport),
      );
      if (
        this.scene === scene &&
        this.plan &&
        sameNodes(this.plan.nodes, visible)
      ) {
        nodes = this.plan.nodes;
        edges = this.plan.edges;
      } else {
        nodes = visible;
        edges = selectRepositoryGraphEdges(scene, visible);
      }
    }

    const hoveredNodeId = options.hoveredNodeId ?? null;
    const selectedNodeId = options.selectedNodeId ?? null;
    const maxLabels = normalizedLabelLimit(options.maxLabels);
    const labelsUnchanged =
      this.plan?.nodes === nodes &&
      this.scale === camera.scale &&
      this.hoveredNodeId === hoveredNodeId &&
      this.selectedNodeId === selectedNodeId &&
      this.maxLabels === maxLabels;
    const labels = labelsUnchanged
      ? this.plan!.labels
      : selectRepositoryGraphLabels(nodes, camera.scale, options);
    const plan =
      this.plan?.nodes === nodes &&
      this.plan.edges === edges &&
      this.plan.labels === labels
        ? this.plan
        : { edges, labels, nodes };
    this.camera = { ...camera };
    this.hoveredNodeId = hoveredNodeId;
    this.maxLabels = maxLabels;
    this.plan = plan;
    this.scale = camera.scale;
    this.scene = scene;
    this.selectedNodeId = selectedNodeId;
    this.viewport = { ...viewport };
    return plan;
  }
}

function setCanvasResolution(
  canvas: HTMLCanvasElement,
  viewport: RepositoryGraphViewport,
  devicePixelRatio: number,
): CanvasRenderingContext2D | null {
  const width = Math.max(1, Math.round(viewport.width * devicePixelRatio));
  const height = Math.max(1, Math.round(viewport.height * devicePixelRatio));
  // CSS owns the display size. Writing the initial 1x1 measured viewport back
  // into the style collapses the canvas and traps ResizeObserver at that size.
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  context?.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  return context;
}

export class Canvas2DRepositoryGraphAdapter implements RepositoryGraphRenderingAdapter {
  private readonly planner = new RepositoryGraphRenderPlanner();

  isSupported(canvas: HTMLCanvasElement): boolean {
    return canvas.getContext("2d") !== null;
  }

  render(
    canvas: HTMLCanvasElement,
    scene: RepositoryGraphScene,
    camera: RepositoryGraphCamera,
    viewport: RepositoryGraphViewport,
    options: RepositoryGraphRenderOptions,
  ): void {
    const pixelRatio = Math.min(2, Math.max(1, options.devicePixelRatio ?? 1));
    const context = setCanvasResolution(canvas, viewport, pixelRatio);
    if (!context) return;
    context.clearRect(0, 0, viewport.width, viewport.height);
    if (options.theme.background !== "transparent") {
      context.fillStyle = options.theme.background;
      context.fillRect(0, 0, viewport.width, viewport.height);
    }

    const plan = this.planner.create(scene, camera, viewport, options);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = options.theme.edge;
    context.lineWidth = options.highContrast ? 1.6 : 1.3;
    context.globalAlpha = options.highContrast ? 0.85 : 0.78;
    for (const edge of plan.edges) {
      const from = repositoryGraphWorldToScreen(edge.from, camera, viewport);
      const to = repositoryGraphWorldToScreen(edge.to, camera, viewport);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    }

    context.globalAlpha = 1;
    for (const node of plan.nodes) {
      const point = repositoryGraphWorldToScreen(node, camera, viewport);
      const radius = Math.max(
        2.5,
        Math.min(36, node.radius * Math.sqrt(camera.scale)),
      );
      const selected = node.id === options.selectedNodeId;
      const hovered = node.id === options.hoveredNodeId;
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fillStyle = node.color;
      context.globalAlpha = node.kind === "ghost" ? 0.42 : 0.94;
      context.fill();
      context.globalAlpha = 1;
      context.strokeStyle =
        selected || hovered
          ? options.theme.selection
          : options.theme.foreground;
      context.lineWidth = selected
        ? 3
        : hovered
          ? 2
          : options.highContrast
            ? 1.5
            : 0.75;
      context.stroke();
      if (node.aggregated) {
        context.beginPath();
        context.arc(point.x, point.y, radius + 4, 0, Math.PI * 2);
        context.setLineDash([2, 3]);
        context.strokeStyle = options.theme.muted;
        context.lineWidth = 1;
        context.stroke();
        context.setLineDash([]);
      }
    }

    context.font = "500 11px ui-sans-serif, system-ui, sans-serif";
    context.textBaseline = "middle";
    for (const node of plan.labels) {
      const point = repositoryGraphWorldToScreen(node, camera, viewport);
      const radius = Math.max(
        2.5,
        Math.min(36, node.radius * Math.sqrt(camera.scale)),
      );
      const suffix = node.hiddenDescendantCount
        ? ` (+${node.hiddenDescendantCount.toLocaleString()})`
        : "";
      const label = `${node.label}${suffix}`;
      context.lineWidth = 3;
      context.strokeStyle =
        options.theme.background === "transparent"
          ? "#000"
          : options.theme.background;
      context.globalAlpha = 0.72;
      context.strokeText(label, point.x + radius + 6, point.y);
      context.globalAlpha = 1;
      context.fillStyle = options.theme.foreground;
      context.fillText(label, point.x + radius + 6, point.y);
    }
  }
}
