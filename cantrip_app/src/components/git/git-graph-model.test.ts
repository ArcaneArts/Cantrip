import {
  gitGraphMetricsSchema,
  gitGraphSnapshotSchema,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  buildGitGraphDisplayModel,
  gitGraphDimensionNeedsMetrics,
} from "./git-graph-model";

const revision = "a".repeat(40);
const snapshot = gitGraphSnapshotSchema.parse({
  analyzerVersion: 1,
  revision,
  branch: "main",
  rootPath: null,
  rootId: "directory:.",
  totalNodes: 3,
  truncated: false,
  analyzedAt: "2026-08-19T12:00:00.000Z",
  analysis: {
    structure: "ready",
    lines: "pending",
    history: "pending",
    blame: "deferred",
  },
  nodes: [
    {
      id: "directory:.",
      path: null,
      parentId: null,
      name: "Cantrip",
      kind: "directory",
      objectId: "b".repeat(40),
      byteSize: 1_100,
      extension: null,
      language: null,
    },
    {
      id: "file:src/app.ts",
      path: "src/app.ts",
      parentId: "directory:.",
      name: "app.ts",
      kind: "file",
      objectId: "c".repeat(40),
      byteSize: 1_000,
      extension: "ts",
      language: "TypeScript",
    },
    {
      id: "file:README.md",
      path: "README.md",
      parentId: "directory:.",
      name: "README.md",
      kind: "file",
      objectId: "d".repeat(40),
      byteSize: 100,
      extension: "md",
      language: "Markdown",
    },
  ],
});

const metrics = gitGraphMetricsSchema.parse({
  analyzerVersion: 1,
  revision,
  rootPath: null,
  historyScope: "current-branch",
  renameAware: false,
  analyzedAt: "2026-08-19T12:00:01.000Z",
  analysis: {
    structure: "ready",
    lines: "ready",
    history: "ready",
    blame: "deferred",
  },
  nodes: snapshot.nodes.map((node, index) => ({
    nodeId: node.id,
    path: node.path,
    lineCount: [110, 100, 10][index],
    binary: false,
    commitTouches: [7, 6, 1][index],
    additions: [90, 80, 10][index],
    deletions: [20, 20, 0][index],
    churn: [110, 100, 10][index],
    binaryCommitTouches: 0,
    firstChangedAt: "2026-08-01T12:00:00.000Z",
    lastChangedAt:
      index === 2 ? "2026-08-18T12:00:00.000Z" : "2026-08-19T12:00:00.000Z",
    dominantAuthorName: null,
    dominantAuthorEmail: null,
    dominantAuthorShare: null,
    averageBlameAgeDays: null,
  })),
});

describe("Git graph display model", () => {
  it("maps size and color dimensions independently with raw metric details", () => {
    const model = buildGitGraphDisplayModel(
      snapshot,
      metrics,
      "lines",
      "commits",
      Date.parse("2026-08-20T12:00:00.000Z"),
    );
    const app = model.nodes.find(({ id }) => id === "file:src/app.ts")!;
    const readme = model.nodes.find(({ id }) => id === "file:README.md")!;
    expect(app.radius).toBeGreaterThan(readme.radius);
    expect(app.color).not.toBe(readme.color);
    expect(app.accessibleDescription).toContain("100 lines");
    expect(app.accessibleDescription).toContain("6 commits");
    expect(model.sizeLegend).toMatchObject({
      label: "Lines of code",
      unavailable: false,
    });
    expect(model.colorLegend).toMatchObject({
      label: "Commit touches",
      unavailable: false,
    });
  });

  it("renders the structural dimensions before progressive metrics arrive", () => {
    const model = buildGitGraphDisplayModel(
      snapshot,
      null,
      "bytes",
      "language",
    );
    expect(model.nodes).toHaveLength(3);
    expect(model.nodes[1]?.radius).toBeGreaterThan(model.nodes[2]?.radius ?? 0);
    expect(model.colorLegend.unavailable).toBe(false);
    expect(gitGraphDimensionNeedsMetrics("bytes")).toBe(false);
    expect(gitGraphDimensionNeedsMetrics("churn")).toBe(true);
  });

  it("keeps unknown metrics unavailable rather than converting them to zero", () => {
    const model = buildGitGraphDisplayModel(snapshot, null, "lines", "churn");
    expect(model.sizeLegend.unavailable).toBe(true);
    expect(model.colorLegend.unavailable).toBe(true);
  });
});
