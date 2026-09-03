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
  radius = kind === "directory" ? 9 : 5,
): RepositoryGraphInputNode {
  return {
    color: kind === "directory" ? "blue" : "green",
    id,
    kind,
    label: id,
    parentId,
    path: id === "root" ? "" : id,
    radius,
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
    expect(scene.edges.find(({ childId }) => childId === "app")).toMatchObject({
      childId: "app",
      parentId: "src",
    });
    expect(
      scene.edgesByNodeId.get("src")?.map(({ childId }) => childId),
    ).toEqual(["src", "app", "test"]);
    expect(scene.nodesById.get("src")?.depth).toBe(1);
    expect(scene.nodesById.get("app")?.depth).toBe(2);
    expect(scene.nodesById.get("root")?.x).toBe(0);
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

  it("packs local clusters radially and lets larger nodes displace their neighbours", () => {
    const broadNodes: RepositoryGraphInputNode[] = [
      node("root", null, "directory"),
    ];
    for (let index = 0; index < 80; index += 1)
      broadNodes.push(node(`file-${index}`, "root"));
    const broad = buildRepositoryGraphScene(broadNodes);
    const width = broad.bounds.maxX - broad.bounds.minX;
    const height = broad.bounds.maxY - broad.bounds.minY;
    expect(width / height).toBeGreaterThan(0.9);
    expect(width / height).toBeLessThan(1.1);

    const evenlySized = [node("root", null, "directory", 7)];
    const enlarged = [node("root", null, "directory", 7)];
    for (let index = 0; index < 12; index += 1) {
      const id = `file-${index}`;
      evenlySized.push(node(id, "root", "file", 4));
      enlarged.push(node(id, "root", "file", index === 5 ? 30 : 4));
    }
    const evenScene = buildRepositoryGraphScene(evenlySized);
    const enlargedScene = buildRepositoryGraphScene(enlarged);
    for (
      let leftIndex = 0;
      leftIndex < enlargedScene.nodes.length;
      leftIndex += 1
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < enlargedScene.nodes.length;
        rightIndex += 1
      ) {
        const left = enlargedScene.nodes[leftIndex]!;
        const right = enlargedScene.nodes[rightIndex]!;
        expect(
          Math.hypot(left.x - right.x, left.y - right.y),
        ).toBeGreaterThanOrEqual(left.radius + right.radius);
      }
    }
    const maximumDistanceFromRoot = (
      scene: ReturnType<typeof buildRepositoryGraphScene>,
    ) =>
      Math.max(
        ...scene.nodes
          .filter((entry) => entry.parentId === "root")
          .map((entry) => Math.hypot(entry.x, entry.y)),
      );
    expect(maximumDistanceFromRoot(enlargedScene)).toBeGreaterThan(
      maximumDistanceFromRoot(evenScene) * 1.1,
    );
  });

  it("keeps files around their directory instead of one global depth ring", () => {
    const nodes: RepositoryGraphInputNode[] = [
      node("root", null, "directory"),
      node("src", "root", "directory"),
      node("docs", "root", "directory"),
    ];
    for (let index = 0; index < 14; index += 1) {
      nodes.push(node(`src/file-${index}`, "src"));
      nodes.push(node(`docs/file-${index}`, "docs"));
    }

    const scene = buildRepositoryGraphScene(nodes);
    const src = scene.nodesById.get("src")!;
    const docs = scene.nodesById.get("docs")!;
    const srcFiles = scene.nodes.filter((entry) => entry.parentId === "src");
    const docsFiles = scene.nodes.filter((entry) => entry.parentId === "docs");
    const distance = (
      left: { x: number; y: number },
      right: { x: number; y: number },
    ) => Math.hypot(left.x - right.x, left.y - right.y);

    expect(
      srcFiles.every((entry) => distance(entry, src) < distance(entry, docs)),
    ).toBe(true);
    expect(
      docsFiles.every((entry) => distance(entry, docs) < distance(entry, src)),
    ).toBe(true);
    expect(
      new Set(srcFiles.map((entry) => Math.round(distance(entry, src)))).size,
    ).toBeGreaterThan(1);
  });

  it("fans directory branches broadly without folding them over their parent", () => {
    const nodes: RepositoryGraphInputNode[] = [
      node("root", null, "directory"),
      node("trunk", "root", "directory"),
    ];
    for (let index = 0; index < 8; index += 1)
      nodes.push(node(`branch-${index}`, "trunk", "directory"));

    const scene = buildRepositoryGraphScene(nodes);
    const root = scene.nodesById.get("root")!;
    const trunk = scene.nodesById.get("trunk")!;
    const outward = { x: trunk.x - root.x, y: trunk.y - root.y };
    const branches = nodes
      .filter(({ parentId }) => parentId === "trunk")
      .map(({ id }) => scene.nodesById.get(id)!);
    const signedRelativeAngles = branches.map((branch) => {
      const offset = { x: branch.x - trunk.x, y: branch.y - trunk.y };
      const cross = outward.x * offset.y - outward.y * offset.x;
      const dot = outward.x * offset.x + outward.y * offset.y;
      return Math.atan2(cross, dot);
    });
    const occupiedQuadrants = new Set(
      signedRelativeAngles.map(
        (angle) => Math.floor((angle + Math.PI) / (Math.PI / 2)) % 4,
      ),
    );

    expect(occupiedQuadrants.size).toBe(4);
    expect(Math.max(...signedRelativeAngles)).toBeGreaterThan(Math.PI * 0.6);
    expect(Math.min(...signedRelativeAngles)).toBeLessThan(-Math.PI * 0.6);
    expect(
      signedRelativeAngles.every((angle) => Math.abs(angle) < Math.PI * 0.85),
    ).toBe(true);
  });

  it("bends long single-directory paths into a stable two-dimensional trunk", () => {
    const nodes: RepositoryGraphInputNode[] = [node("root", null, "directory")];
    let parentId = "root";
    for (let depth = 1; depth <= 10; depth += 1) {
      const id = `nested-${depth}`;
      nodes.push(node(id, parentId, "directory"));
      parentId = id;
    }

    const scene = buildRepositoryGraphScene(nodes);
    const first = scene.nodesById.get("nested-1")!;
    const middle = scene.nodesById.get("nested-5")!;
    const last = scene.nodesById.get("nested-10")!;
    const width = scene.bounds.maxX - scene.bounds.minX;
    const height = scene.bounds.maxY - scene.bounds.minY;

    expect(Math.abs(first.x)).toBeLessThan(0.000_001);
    expect(Math.abs(middle.x)).toBeGreaterThan(100);
    expect(Math.abs(last.x)).toBeGreaterThan(Math.abs(middle.x));
    expect(width / height).toBeGreaterThan(0.65);
    expect(width / height).toBeLessThan(1.5);

    const rebuilt = buildRepositoryGraphScene(nodes);
    expect(rebuilt.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      scene.nodes.map(({ id, x, y }) => ({ id, x, y })),
    );
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
