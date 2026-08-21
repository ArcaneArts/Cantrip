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

export function createRepositoryGraphRenderPlan(
  scene: RepositoryGraphScene,
  camera: RepositoryGraphCamera,
  viewport: RepositoryGraphViewport,
  options: Pick<
    RepositoryGraphRenderOptions,
    "hoveredNodeId" | "maxLabels" | "selectedNodeId"
  > = {},
): RepositoryGraphRenderPlan {
  const visible = queryRepositoryGraphNodes(
    scene,
    repositoryGraphViewportWorldBounds(camera, viewport),
  );
  const visibleIds = new Set(visible.map((node) => node.id));
  const edges = scene.edges.filter(
    (edge) =>
      visibleIds.has(edge.parentId) ||
      visibleIds.has(edge.id.split("->")[1] ?? ""),
  );
  const maxLabels = Math.max(0, options.maxLabels ?? 120);
  const prioritized = visible
    .filter(
      (node) =>
        node.id === options.selectedNodeId ||
        node.id === options.hoveredNodeId ||
        node.kind === "directory" ||
        node.aggregated ||
        node.radius * camera.scale >= 7,
    )
    .sort((left, right) => {
      const leftSelected =
        left.id === options.selectedNodeId || left.id === options.hoveredNodeId;
      const rightSelected =
        right.id === options.selectedNodeId ||
        right.id === options.hoveredNodeId;
      if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
      if (left.kind !== right.kind)
        return left.kind === "directory"
          ? -1
          : right.kind === "directory"
            ? 1
            : 0;
      return right.radius - left.radius;
    });
  return { edges, labels: prioritized.slice(0, maxLabels), nodes: visible };
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

    const plan = createRepositoryGraphRenderPlan(
      scene,
      camera,
      viewport,
      options,
    );
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
