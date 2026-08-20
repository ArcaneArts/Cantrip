import { describe, expect, it, vi } from "vitest";

import { defaultRepositoryGraphCamera } from "./repository-graph-camera";
import {
  Canvas2DRepositoryGraphAdapter,
  createRepositoryGraphRenderPlan,
} from "./repository-graph-canvas";
import {
  buildRepositoryGraphScene,
  type RepositoryGraphInputNode,
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
});
