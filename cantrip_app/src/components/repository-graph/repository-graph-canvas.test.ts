import { describe, expect, it } from "vitest";

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
});
