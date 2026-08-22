import { describe, expect, it, vi } from "vitest";

import {
  defaultRepositoryGraphCamera,
  fitRepositoryGraphCamera,
  repositoryGraphViewportWorldBounds,
  type RepositoryGraphCamera,
  type RepositoryGraphViewport,
} from "./repository-graph-camera";
import {
  Canvas2DRepositoryGraphAdapter,
  RepositoryGraphRenderPlanner,
  createRepositoryGraphRenderPlan,
  type RepositoryGraphRenderPlan,
} from "./repository-graph-canvas";
import {
  buildRepositoryGraphScene,
  queryRepositoryGraphNodes,
  type RepositoryGraphInputNode,
  type RepositoryGraphScene,
} from "./repository-graph-model";

function node(id: string, parentId: string | null): RepositoryGraphInputNode {
  return {
    color: "cyan",
    id,
    kind: parentId ? "file" : "directory",
    label: id,
    parentId,
    path: id,
    radius: 6,
  };
}

function legacyRenderPlan(
  scene: RepositoryGraphScene,
  camera: RepositoryGraphCamera,
  viewport: RepositoryGraphViewport,
  options: {
    hoveredNodeId?: string | null;
    maxLabels?: number;
    selectedNodeId?: string | null;
  } = {},
): RepositoryGraphRenderPlan {
  const visible = queryRepositoryGraphNodes(
    scene,
    repositoryGraphViewportWorldBounds(camera, viewport),
  );
  const visibleIds = new Set(visible.map((entry) => entry.id));
  const edges = scene.edges.filter(
    (edge) =>
      visibleIds.has(edge.parentId) ||
      visibleIds.has(edge.id.split("->")[1] ?? ""),
  );
  const maxLabels = Math.max(0, options.maxLabels ?? 120);
  const prioritized = visible
    .filter(
      (entry) =>
        entry.id === options.selectedNodeId ||
        entry.id === options.hoveredNodeId ||
        entry.kind === "directory" ||
        entry.aggregated ||
        entry.radius * camera.scale >= 7,
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

function benchmarkScene(nodeCount: number): RepositoryGraphScene {
  const directoryCount = Math.min(32, Math.max(1, Math.floor(nodeCount / 30)));
  const nodes: RepositoryGraphInputNode[] = [
    {
      ...node("root", null),
      kind: "directory",
      radius: 12,
    },
  ];
  for (let index = 0; index < directoryCount; index += 1) {
    nodes.push({
      ...node(`dir-${index}`, "root"),
      kind: "directory",
      radius: 8 + (index % 5),
    });
  }
  for (let index = nodes.length; index < nodeCount; index += 1) {
    nodes.push({
      ...node(`file-${index}`, `dir-${index % directoryCount}`),
      radius: 3 + (index % 9),
    });
  }
  return buildRepositoryGraphScene(nodes, { maxVisibleNodes: nodeCount });
}

function benchmarkCameras(
  scene: RepositoryGraphScene,
  viewport: RepositoryGraphViewport,
): RepositoryGraphCamera[] {
  const fit = fitRepositoryGraphCamera(scene.bounds, viewport, { padding: 24 });
  const width = scene.bounds.maxX - scene.bounds.minX;
  const height = scene.bounds.maxY - scene.bounds.minY;
  return Array.from({ length: 48 }, (_, index) => {
    const progress = index / 47;
    return {
      centerX: fit.centerX + (progress - 0.5) * width * 0.28,
      centerY: fit.centerY + Math.sin(progress * Math.PI * 2) * height * 0.12,
      rotation: Math.sin(progress * Math.PI) * 0.08,
      scale: fit.scale * (2.2 + Math.sin(progress * Math.PI * 2) * 0.18),
    };
  });
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

const benchmarkEnabled =
  (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env?.CANTRIP_BENCHMARK_REPOSITORY_GRAPH === "1";

describe("repository graph canvas render planning", () => {
  it("reports a graceful unsupported state when Canvas2D is unavailable", () => {
    const canvas = {
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    expect(new Canvas2DRepositoryGraphAdapter().isSupported(canvas)).toBe(
      false,
    );
  });

  it("culls offscreen nodes and caps labels independently of the scene size", () => {
    const nodes = [node("root", null)];
    for (let index = 0; index < 500; index += 1)
      nodes.push(node(`file-${index}`, "root"));
    const scene = buildRepositoryGraphScene(nodes);
    const plan = createRepositoryGraphRenderPlan(
      scene,
      defaultRepositoryGraphCamera(),
      { height: 300, width: 400 },
      { maxLabels: 8 },
    );
    expect(plan.nodes.length).toBeLessThan(scene.nodes.length);
    expect(plan.labels.length).toBeLessThanOrEqual(8);
  });

  it("keeps a selected small node at the front of the label budget", () => {
    const scene = buildRepositoryGraphScene([
      node("root", null),
      node("alpha", "root"),
      node("beta", "root"),
    ]);
    const plan = createRepositoryGraphRenderPlan(
      scene,
      defaultRepositoryGraphCamera(),
      { height: 1_000, width: 1_000 },
      { maxLabels: 1, selectedNodeId: "beta" },
    );
    expect(plan.labels.map((entry) => entry.id)).toEqual(["beta"]);
  });

  it("matches the previous visible nodes, labels, and edge set", () => {
    const scene = benchmarkScene(500);
    const viewport = { height: 720, width: 1_100 };
    for (const camera of benchmarkCameras(scene, viewport)) {
      const options = {
        hoveredNodeId: "file-200",
        maxLabels: 37,
        selectedNodeId: "file-400",
      };
      const previous = legacyRenderPlan(scene, camera, viewport, options);
      const current = createRepositoryGraphRenderPlan(
        scene,
        camera,
        viewport,
        options,
      );
      expect(current.nodes).toEqual(previous.nodes);
      expect(current.labels).toEqual(previous.labels);
      expect(current.edges.map(({ id }) => id).sort()).toEqual(
        previous.edges.map(({ id }) => id).sort(),
      );
    }
  });

  it("reuses plans across hover frames and small moves with unchanged culling", () => {
    const scene = buildRepositoryGraphScene([
      node("root", null),
      node("alpha", "root"),
      node("beta", "root"),
    ]);
    const viewport = { height: 1_000, width: 1_000 };
    const planner = new RepositoryGraphRenderPlanner();
    const camera = defaultRepositoryGraphCamera();
    const initial = planner.create(scene, camera, viewport);
    expect(planner.create(scene, camera, viewport)).toBe(initial);

    const hovered = planner.create(scene, camera, viewport, {
      hoveredNodeId: "beta",
    });
    expect(hovered).not.toBe(initial);
    expect(hovered.nodes).toBe(initial.nodes);
    expect(hovered.edges).toBe(initial.edges);

    const moved = planner.create(
      scene,
      { ...camera, centerX: camera.centerX + 0.1 },
      viewport,
      { hoveredNodeId: "beta" },
    );
    expect(moved).toBe(hovered);

    const rebuilt = planner.create(
      buildRepositoryGraphScene([
        node("root", null),
        node("alpha", "root"),
        node("beta", "root"),
      ]),
      camera,
      viewport,
      { hoveredNodeId: "beta" },
    );
    expect(rebuilt).not.toBe(moved);
  });

  it("preserves CSS layout sizing while updating the backing resolution", () => {
    const context = {
      clearRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      getContext: () => context,
      height: 150,
      style: { height: "100%", width: "100%" },
      width: 300,
    } as unknown as HTMLCanvasElement;

    new Canvas2DRepositoryGraphAdapter().render(
      canvas,
      buildRepositoryGraphScene([]),
      defaultRepositoryGraphCamera(),
      { height: 600, width: 800 },
      {
        devicePixelRatio: 2,
        theme: {
          background: "transparent",
          edge: "gray",
          foreground: "white",
          muted: "silver",
          selection: "purple",
        },
      },
    );

    expect(canvas.width).toBe(1_600);
    expect(canvas.height).toBe(1_200);
    expect(canvas.style.width).toBe("100%");
    expect(canvas.style.height).toBe("100%");
  });

  it.skipIf(!benchmarkEnabled)(
    "benchmarks continuous 500, 2K, and 4K-node camera frames",
    () => {
      const viewport = { height: 800, width: 1_200 };
      const metrics: Array<Record<string, number>> = [];
      for (const nodeCount of [500, 2_000, 4_000]) {
        const scene = benchmarkScene(nodeCount);
        const cameras = benchmarkCameras(scene, viewport);
        const expected = cameras.map((camera) =>
          legacyRenderPlan(scene, camera, viewport),
        );
        const equivalencePlanner = new RepositoryGraphRenderPlanner();
        cameras.forEach((camera, index) => {
          const current = equivalencePlanner.create(scene, camera, viewport);
          expect(current.nodes).toEqual(expected[index]!.nodes);
          expect(current.labels).toEqual(expected[index]!.labels);
          expect(current.edges.map(({ id }) => id).sort()).toEqual(
            expected[index]!.edges.map(({ id }) => id).sort(),
          );
        });

        const run = (optimized: boolean) => {
          const totals: number[] = [];
          const frames: number[] = [];
          const heapDeltas: number[] = [];
          let sink = 0;
          for (let iteration = -5; iteration < 25; iteration += 1) {
            const planner = optimized
              ? new RepositoryGraphRenderPlanner()
              : null;
            const memory = (
              globalThis as typeof globalThis & {
                process?: { memoryUsage?: () => { heapUsed: number } };
              }
            ).process?.memoryUsage;
            const heapBefore = memory?.().heapUsed ?? 0;
            const startedAt = performance.now();
            const iterationFrames: number[] = [];
            for (const camera of cameras) {
              const frameStartedAt = performance.now();
              const plan = planner
                ? planner.create(scene, camera, viewport)
                : legacyRenderPlan(scene, camera, viewport);
              iterationFrames.push(performance.now() - frameStartedAt);
              sink +=
                plan.nodes.length + plan.edges.length + plan.labels.length;
            }
            const total = performance.now() - startedAt;
            if (iteration < 0) continue;
            totals.push(total);
            frames.push(...iterationFrames);
            heapDeltas.push((memory?.().heapUsed ?? heapBefore) - heapBefore);
          }
          expect(sink).toBeGreaterThan(0);
          return {
            droppedFrames: frames.filter((duration) => duration > 16.67).length,
            frameP95Ms: percentile(frames, 0.95),
            heapDeltaMedianBytes: percentile(heapDeltas, 0.5),
            totalP50Ms: percentile(totals, 0.5),
            totalP95Ms: percentile(totals, 0.95),
          };
        };
        const baseline = run(false);
        const optimized = run(true);
        expect(optimized.totalP50Ms).toBeLessThan(baseline.totalP50Ms * 0.95);
        metrics.push({
          baselineDroppedFrames: baseline.droppedFrames,
          baselineFrameP95Ms: baseline.frameP95Ms,
          baselineHeapDeltaMedianBytes: baseline.heapDeltaMedianBytes,
          baselineTotalP50Ms: baseline.totalP50Ms,
          baselineTotalP95Ms: baseline.totalP95Ms,
          nodeCount,
          optimizedDroppedFrames: optimized.droppedFrames,
          optimizedFrameP95Ms: optimized.frameP95Ms,
          optimizedHeapDeltaMedianBytes: optimized.heapDeltaMedianBytes,
          optimizedTotalP50Ms: optimized.totalP50Ms,
          optimizedTotalP95Ms: optimized.totalP95Ms,
        });
      }
      console.info("Repository graph render-plan benchmark", {
        framesPerIteration: 48,
        iterations: 25,
        metrics,
        warmups: 5,
      });
    },
    120_000,
  );
});
