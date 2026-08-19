import { describe, expect, it } from "vitest";

import {
  buildRepositoryGraphScene,
  hitTestRepositoryGraph,
  queryRepositoryGraphNodes,
  type RepositoryGraphInputNode,
} from "./repository-graph-model";

function node(
  id: string,
  parentId: string | null,
  kind: RepositoryGraphInputNode["kind"] = "file",
): RepositoryGraphInputNode {
  return {
    color: kind === "directory" ? "blue" : "green",
    id,
    kind,
    label: id,
    parentId,
    path: id === "root" ? "" : id,
    radius: kind === "directory" ? 9 : 5,
  };
}

describe("repository graph model", () => {
  it("lays out a stable hierarchy and indexes node hit targets", () => {
    const scene = buildRepositoryGraphScene([
      node("root", null, "directory"),
      node("src", "root", "directory"),
      node("readme", "root"),
      node("app", "src"),
      node("test", "src"),
    ]);

    expect(scene.nodes.map((entry) => entry.id)).toEqual([
      "root",
      "src",
      "readme",
      "app",
      "test",
    ]);
    expect(scene.edges).toHaveLength(4);
    expect(scene.nodesById.get("src")?.depth).toBe(1);
    expect(scene.nodesById.get("app")?.depth).toBe(2);
    expect(scene.nodesById.get("root")?.y).toBe(0);
    const app = scene.nodesById.get("app")!;
    expect(hitTestRepositoryGraph(scene, app)).toMatchObject({ id: "app" });
    expect(
      queryRepositoryGraphNodes(scene, {
        maxX: app.x + 1,
        maxY: app.y + 1,
        minX: app.x - 1,
        minY: app.y - 1,
      }).map((entry) => entry.id),
    ).toContain("app");
  });

  it("bounds large hierarchies and reports aggregation without dropping the source count", () => {
    const nodes: RepositoryGraphInputNode[] = [node("root", null, "directory")];
    for (let directory = 0; directory < 20; directory += 1) {
      const directoryId = `dir-${directory}`;
      nodes.push(node(directoryId, "root", "directory"));
      for (let file = 0; file < 100; file += 1)
        nodes.push(node(`${directoryId}/file-${file}`, directoryId));
    }

    const scene = buildRepositoryGraphScene(nodes, { maxVisibleNodes: 120 });
    expect(scene.nodes).toHaveLength(120);
    expect(scene.totalNodeCount).toBe(2_021);
    expect(scene.hiddenNodeCount).toBe(1_901);
    expect(scene.nodesById.get("dir-1")?.aggregated).toBe(true);
    expect(scene.nodesById.get("dir-1")?.hiddenDescendantCount).toBeGreaterThan(
      0,
    );
  });

  it("bounds deeply nested repositories without recursive stack growth", () => {
    const nodes: RepositoryGraphInputNode[] = [node("root", null, "directory")];
    let parentId = "root";
    for (let depth = 1; depth <= 8_000; depth += 1) {
      const id = `depth-${depth}`;
      nodes.push(node(id, parentId, "directory"));
      parentId = id;
    }

    const scene = buildRepositoryGraphScene(nodes, { maxVisibleNodes: 4_000 });
    expect(scene.nodes).toHaveLength(4_000);
    expect(scene.totalNodeCount).toBe(8_001);
    expect(scene.hiddenNodeCount).toBe(4_001);
    expect(scene.nodes.at(-1)?.aggregated).toBe(true);
    expect(scene.nodes.at(-1)?.hiddenDescendantCount).toBe(4_001);
  });

  it("honors explicit directory collapse and scoped roots", () => {
    const nodes = [
      node("root", null, "directory"),
      node("src", "root", "directory"),
      node("docs", "root", "directory"),
      node("app", "src"),
      node("guide", "docs"),
    ];
    const collapsed = buildRepositoryGraphScene(nodes, {
      collapsedNodeIds: new Set(["src"]),
    });
    expect(collapsed.nodes.map((entry) => entry.id)).not.toContain("app");
    expect(collapsed.nodesById.get("src")?.hiddenDescendantCount).toBe(1);

    const scoped = buildRepositoryGraphScene(nodes, { rootNodeId: "docs" });
    expect(scoped.nodes.map((entry) => entry.id)).toEqual(["docs", "guide"]);
    expect(scoped.totalNodeCount).toBe(2);
  });
});
