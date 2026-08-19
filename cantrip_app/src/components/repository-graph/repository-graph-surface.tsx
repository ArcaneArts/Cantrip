import { Compass, Maximize2 } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  defaultRepositoryGraphCamera,
  fitRepositoryGraphCamera,
  repositoryGraphScreenToWorld,
  resetRepositoryGraphRotation,
  rotateRepositoryGraphCameraAt,
  zoomRepositoryGraphCameraAt,
  type RepositoryGraphCamera,
  type RepositoryGraphViewport,
} from "./repository-graph-camera";
import {
  Canvas2DRepositoryGraphAdapter,
  type RepositoryGraphCanvasTheme,
  type RepositoryGraphRenderingAdapter,
} from "./repository-graph-canvas";
import { RepositoryGraphGestureController } from "./repository-graph-gestures";
import {
  buildRepositoryGraphScene,
  hitTestRepositoryGraph,
  type RepositoryGraphInputNode,
  type RepositoryGraphSceneNode,
} from "./repository-graph-model";

export type RepositoryGraphSurfaceProps = {
  ariaLabel?: string;
  autoFit?: boolean;
  camera?: RepositoryGraphCamera;
  className?: string;
  collapsedNodeIds?: ReadonlySet<string>;
  highContrast?: boolean;
  maxVisibleNodes?: number;
  nodes: readonly RepositoryGraphInputNode[];
  onActivateNode?(node: RepositoryGraphSceneNode): void;
  onCameraChange?(camera: RepositoryGraphCamera): void;
  onSelectionChange?(node: RepositoryGraphSceneNode | null): void;
  renderer?: RepositoryGraphRenderingAdapter;
  rootNodeId?: string | null;
  selectedNodeId?: string | null;
  theme?: Partial<RepositoryGraphCanvasTheme>;
};

const DEFAULT_THEME: RepositoryGraphCanvasTheme = {
  background: "transparent",
  edge: "rgba(148, 163, 184, 0.7)",
  foreground: "#e5e7eb",
  muted: "#94a3b8",
  selection: "#a855f7",
};

function localPoint(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
) {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function firstSelectableIndex(
  nodes: readonly RepositoryGraphSceneNode[],
  selectedNodeId: string | null | undefined,
): number {
  const selectedIndex = selectedNodeId
    ? nodes.findIndex((node) => node.id === selectedNodeId)
    : -1;
  return selectedIndex >= 0 ? selectedIndex : 0;
}

export function RepositoryGraphSurface({
  ariaLabel = "Repository graph",
  autoFit = true,
  camera: controlledCamera,
  className,
  collapsedNodeIds,
  highContrast = false,
  maxVisibleNodes,
  nodes,
  onActivateNode,
  onCameraChange,
  onSelectionChange,
  renderer,
  rootNodeId,
  selectedNodeId: controlledSelectedNodeId,
  theme,
}: RepositoryGraphSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<RepositoryGraphViewport>({
    height: 1,
    width: 1,
  });
  const [internalCamera, setInternalCamera] = useState(
    defaultRepositoryGraphCamera,
  );
  const [internalSelectedNodeId, setInternalSelectedNodeId] = useState<
    string | null
  >(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [rendererUnavailable, setRendererUnavailable] = useState(false);
  const camera = controlledCamera ?? internalCamera;
  const selectedNodeId = controlledSelectedNodeId ?? internalSelectedNodeId;
  const cameraRef = useRef(camera);
  const viewportRef = useRef(viewport);
  const movedPointersRef = useRef(new Set<number>());
  const pointerStartsRef = useRef(
    new Map<number, { point: { x: number; y: number }; time: number }>(),
  );
  const lastTapRef = useRef<{ nodeId: string; time: number } | null>(null);
  const framedRootRef = useRef<string | null | undefined>(undefined);
  const adapterRef = useRef<RepositoryGraphRenderingAdapter>(
    renderer ?? new Canvas2DRepositoryGraphAdapter(),
  );

  const scene = useMemo(
    () =>
      buildRepositoryGraphScene(nodes, {
        collapsedNodeIds,
        maxVisibleNodes,
        rootNodeId,
      }),
    [collapsedNodeIds, maxVisibleNodes, nodes, rootNodeId],
  );
  const canvasTheme = useMemo(() => ({ ...DEFAULT_THEME, ...theme }), [theme]);

  cameraRef.current = camera;
  viewportRef.current = viewport;
  if (renderer && renderer !== adapterRef.current)
    adapterRef.current = renderer;

  const setCamera = useCallback(
    (next: RepositoryGraphCamera) => {
      cameraRef.current = next;
      if (controlledCamera === undefined) setInternalCamera(next);
      onCameraChange?.(next);
    },
    [controlledCamera, onCameraChange],
  );
  const setCameraRef = useRef(setCamera);
  setCameraRef.current = setCamera;

  const selectNode = useCallback(
    (node: RepositoryGraphSceneNode | null) => {
      if (controlledSelectedNodeId === undefined)
        setInternalSelectedNodeId(node?.id ?? null);
      onSelectionChange?.(node);
    },
    [controlledSelectedNodeId, onSelectionChange],
  );

  const gestureRef = useRef<RepositoryGraphGestureController | null>(null);
  if (!gestureRef.current) {
    gestureRef.current = new RepositoryGraphGestureController({
      getCamera: () => cameraRef.current,
      getViewport: () => viewportRef.current,
      setCamera: (next) => setCameraRef.current(next),
    });
  }

  const fitView = useCallback(
    (preserveRotation = true) => {
      if (!scene.nodes.length || viewport.width <= 1 || viewport.height <= 1)
        return;
      setCamera(
        fitRepositoryGraphCamera(scene.bounds, viewport, {
          padding: 48,
          rotation: preserveRotation ? cameraRef.current.rotation : 0,
        }),
      );
    },
    [scene, setCamera, viewport],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const bounds = canvas.getBoundingClientRect();
      setViewport({
        height: Math.max(1, bounds.height),
        width: Math.max(1, bounds.width),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!scene.rootNodeId || viewport.width <= 1 || viewport.height <= 1)
      return;
    if (framedRootRef.current === scene.rootNodeId) return;
    if (framedRootRef.current === undefined && !autoFit) {
      framedRootRef.current = scene.rootNodeId;
      return;
    }
    framedRootRef.current = scene.rootNodeId;
    setCamera(
      fitRepositoryGraphCamera(scene.bounds, viewport, { padding: 48 }),
    );
  }, [autoFit, scene.bounds, scene.rootNodeId, setCamera, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const adapter = adapterRef.current;
    if (adapter.isSupported && !adapter.isSupported(canvas)) {
      setRendererUnavailable(true);
      return;
    }
    setRendererUnavailable(false);
    const computed = getComputedStyle(canvas);
    const resolvedTheme = {
      ...canvasTheme,
      edge: computed.getPropertyValue("--border").trim() || canvasTheme.edge,
      foreground:
        computed.getPropertyValue("--foreground").trim() ||
        canvasTheme.foreground,
      muted:
        computed.getPropertyValue("--muted-foreground").trim() ||
        canvasTheme.muted,
      selection:
        computed.getPropertyValue("--ring").trim() || canvasTheme.selection,
    };
    adapter.render(canvas, scene, camera, viewport, {
      devicePixelRatio:
        typeof window === "undefined" ? 1 : window.devicePixelRatio,
      highContrast:
        highContrast ||
        document.documentElement.classList.contains("high-contrast"),
      hoveredNodeId,
      selectedNodeId,
      theme: resolvedTheme,
    });
  }, [
    camera,
    canvasTheme,
    highContrast,
    hoveredNodeId,
    renderer,
    scene,
    selectedNodeId,
    viewport,
  ]);

  const hitTest = useCallback(
    (point: { x: number; y: number }, mobile = false) =>
      hitTestRepositoryGraph(
        scene,
        repositoryGraphScreenToWorld(
          point,
          cameraRef.current,
          viewportRef.current,
        ),
        (mobile ? 18 : 10) / cameraRef.current.scale,
      ),
    [scene],
  );

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    const point = localPoint(canvas, event);
    pointerStartsRef.current.set(event.pointerId, {
      point,
      time: performance.now(),
    });
    gestureRef.current?.pointerDown({ id: event.pointerId, ...point });
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const point = localPoint(canvas, event);
    const start = pointerStartsRef.current.get(event.pointerId);
    if (
      start &&
      Math.hypot(point.x - start.point.x, point.y - start.point.y) > 4
    )
      movedPointersRef.current.add(event.pointerId);
    if (gestureRef.current?.activePointerCount) {
      gestureRef.current.pointerMove({ id: event.pointerId, ...point });
      return;
    }
    setHoveredNodeId(hitTest(point, event.pointerType === "touch")?.id ?? null);
  };

  const finishPointer = (
    event: PointerEvent<HTMLCanvasElement>,
    cancelled: boolean,
  ) => {
    const canvas = canvasRef.current;
    const start = pointerStartsRef.current.get(event.pointerId);
    const moved = movedPointersRef.current.has(event.pointerId);
    pointerStartsRef.current.delete(event.pointerId);
    movedPointersRef.current.delete(event.pointerId);
    gestureRef.current?.pointerUp(event.pointerId);
    if (!canvas || cancelled || !start || moved) return;
    const point = localPoint(canvas, event);
    const node = hitTest(point, event.pointerType === "touch");
    selectNode(node);
    if (!node || performance.now() - start.time > 600) return;
    if (node.kind === "file" || node.kind === "ghost") {
      onActivateNode?.(node);
      lastTapRef.current = null;
      return;
    }
    const previousTap = lastTapRef.current;
    if (
      previousTap?.nodeId === node.id &&
      performance.now() - previousTap.time < 360
    ) {
      onActivateNode?.(node);
      lastTapRef.current = null;
    } else {
      lastTapRef.current = { nodeId: node.id, time: performance.now() };
    }
  };

  const handleWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const point = localPoint(canvas, event);
    if (event.shiftKey) {
      setCamera(
        rotateRepositoryGraphCameraAt(
          cameraRef.current,
          event.deltaY * 0.003,
          point,
          viewportRef.current,
        ),
      );
    } else {
      setCamera(
        zoomRepositoryGraphCameraAt(
          cameraRef.current,
          Math.exp(-event.deltaY * 0.0015),
          point,
          viewportRef.current,
        ),
      );
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!scene.nodes.length) return;
    const currentIndex = firstSelectableIndex(scene.nodes, selectedNodeId);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight")
      nextIndex = Math.min(scene.nodes.length - 1, currentIndex + 1);
    if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === "Home") nextIndex = 0;
    if (nextIndex !== null) {
      event.preventDefault();
      selectNode(scene.nodes[nextIndex] ?? null);
      return;
    }
    if (event.key === "Enter" && scene.nodes[currentIndex]) {
      event.preventDefault();
      onActivateNode?.(scene.nodes[currentIndex]!);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setCamera(
        zoomRepositoryGraphCameraAt(
          cameraRef.current,
          1.25,
          { x: viewport.width / 2, y: viewport.height / 2 },
          viewport,
        ),
      );
    } else if (event.key === "-") {
      event.preventDefault();
      setCamera(
        zoomRepositoryGraphCameraAt(
          cameraRef.current,
          0.8,
          { x: viewport.width / 2, y: viewport.height / 2 },
          viewport,
        ),
      );
    } else if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      setCamera(resetRepositoryGraphRotation(cameraRef.current));
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      fitView();
    }
  };

  const selectedNode = selectedNodeId
    ? scene.nodesById.get(selectedNodeId)
    : undefined;
  const detailNode =
    selectedNode ??
    (hoveredNodeId ? scene.nodesById.get(hoveredNodeId) : undefined);

  return (
    <section
      className={cn(
        "relative isolate min-h-72 w-full overflow-hidden rounded-lg border bg-background/45",
        className,
      )}
      data-repository-graph-surface
    >
      <canvas
        ref={canvasRef}
        aria-label={ariaLabel}
        className="block size-full min-h-72 cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
        onKeyDown={handleKeyDown}
        onPointerCancel={(event) => finishPointer(event, true)}
        onPointerDown={handlePointerDown}
        onPointerLeave={() => setHoveredNodeId(null)}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event, false)}
        onWheel={handleWheel}
        aria-roledescription="interactive repository graph"
        role="application"
        style={{ touchAction: "none" }}
        tabIndex={0}
      />

      {rendererUnavailable ? (
        <div
          className="absolute inset-0 grid place-items-center bg-background/88 p-6 text-center text-sm text-muted-foreground backdrop-blur-sm"
          role="status"
        >
          Repository graph rendering is unavailable in this browser. File
          navigation remains available in Explorer.
        </div>
      ) : null}

      <div className="absolute right-3 top-3 flex gap-1.5">
        <Button
          aria-label="Fit repository graph to view"
          onClick={() => fitView()}
          className="size-8"
          size="icon"
          type="button"
          variant="outline"
        >
          <Maximize2 aria-hidden="true" className="size-4" />
        </Button>
        <Button
          aria-label="Reset repository graph rotation"
          onClick={() =>
            setCamera(resetRepositoryGraphRotation(cameraRef.current))
          }
          className="size-8"
          size="icon"
          type="button"
          variant="outline"
        >
          <Compass
            aria-hidden="true"
            className="size-4 transition-transform motion-reduce:transition-none"
            style={{ transform: `rotate(${-camera.rotation}rad)` }}
          />
        </Button>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 max-w-[min(28rem,calc(100%-1.5rem))] rounded-md border bg-background/88 px-3 py-2 text-xs shadow-sm backdrop-blur">
        {detailNode ? (
          <>
            <p className="truncate font-medium">{detailNode.label}</p>
            <p className="truncate text-muted-foreground">
              {detailNode.accessibleDescription ?? detailNode.path}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            Pan with one pointer. Pinch, pan, and twist with two. Shift-scroll
            rotates.
          </p>
        )}
        {scene.hiddenNodeCount > 0 ? (
          <p className="mt-1 text-muted-foreground">
            {scene.hiddenNodeCount.toLocaleString()} entries aggregated for
            performance.
          </p>
        ) : null}
      </div>

      <p aria-live="polite" className="sr-only">
        {selectedNode
          ? `Selected ${selectedNode.kind} ${selectedNode.path}. ${
              selectedNode.accessibleDescription ?? ""
            }`
          : `${scene.nodes.length.toLocaleString()} graph nodes visible.`}
      </p>
    </section>
  );
}
