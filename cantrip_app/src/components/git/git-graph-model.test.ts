import {
  gitGraphCommitOverlaySchema,
  gitGraphMetricsSchema,
  gitGraphSnapshotSchema,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  applyGitGraphCommitOverlay,
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
    expect(app.radius).toBe(30);
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

    const equal = buildGitGraphDisplayModel(
      snapshot,
      metrics,
      "equal",
      "language",
    );
    expect(new Set(equal.nodes.map((node) => node.radius))).toEqual(
      new Set([7]),
    );
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

  it("renders lazy blame ownership and surviving-line age as real dimensions", () => {
    const blameMetrics = gitGraphMetricsSchema.parse({
      ...metrics,
      blameCoverage: { analyzedFiles: 2, totalFiles: 2, truncated: false },
      analysis: { ...metrics.analysis, blame: "ready" },
      nodes: metrics.nodes.map((entry, index) => ({
        ...entry,
        dominantAuthorEmail:
          index === 2 ? "docs@example.com" : "app@example.com",
        dominantAuthorName: index === 2 ? "Docs" : "Application",
        dominantAuthorShare: index === 2 ? 0.75 : 0.9,
        averageBlameAgeDays: index === 2 ? 12 : 3,
      })),
    });
    const owners = buildGitGraphDisplayModel(
      snapshot,
      blameMetrics,
      "equal",
      "blame-owner",
    );
    const ages = buildGitGraphDisplayModel(
      snapshot,
      blameMetrics,
      "equal",
      "blame-age",
    );

    expect(owners.colorLegend.unavailable).toBe(false);
    expect(owners.nodes[1]?.color).not.toBe(owners.nodes[2]?.color);
    expect(owners.nodes[1]?.accessibleDescription).toContain(
      "90% current lines",
    );
    expect(ages.colorLegend).toMatchObject({
      minimum: "3 days",
      maximum: "12 days",
      unavailable: false,
    });
    expect(ages.nodes[2]?.accessibleDescription).toContain(
      "12 days average line age",
    );
  });

  it("overlays commit weight and status while preserving deleted files as ghosts", () => {
    const nestedSnapshot = gitGraphSnapshotSchema.parse({
      ...snapshot,
      totalNodes: 4,
      nodes: [
        snapshot.nodes[0],
        {
          id: "directory:src",
          path: "src",
          parentId: "directory:.",
          name: "src",
          kind: "directory",
          objectId: "f".repeat(40),
          byteSize: 1_000,
          extension: null,
          language: null,
        },
        { ...snapshot.nodes[1], parentId: "directory:src" },
        snapshot.nodes[2],
      ],
    });
    const base = buildGitGraphDisplayModel(
      nestedSnapshot,
      null,
      "bytes",
      "language",
    );
    const overlay = gitGraphCommitOverlaySchema.parse({
      revision,
      baseRevision: "e".repeat(40),
      rootPath: null,
      filesChanged: 3,
      additions: 24,
      deletions: 9,
      truncated: false,
      nodes: [
        {
          path: "src/app.ts",
          originalPath: "src/old-app.ts",
          status: "renamed",
          additions: 20,
          deletions: 2,
          weight: 22,
          binary: false,
          ghost: false,
        },
        {
          path: "README.md",
          originalPath: null,
          status: "modified",
          additions: 4,
          deletions: 1,
          weight: 5,
          binary: false,
          ghost: false,
        },
        {
          path: "src/removed.ts",
          originalPath: null,
          status: "deleted",
          additions: 0,
          deletions: 6,
          weight: 6,
          binary: false,
          ghost: true,
        },
      ],
    });
    const model = applyGitGraphCommitOverlay(base, nestedSnapshot, overlay);
    const renamed = model.nodes.find(({ path }) => path === "src/app.ts")!;
    const readme = model.nodes.find(({ path }) => path === "README.md")!;
    const ghost = model.nodes.find(({ path }) => path === "src/removed.ts")!;
    const sourceDirectory = model.nodes.find(({ path }) => path === "src")!;
    expect(renamed.radius).toBe(
      base.nodes.find(({ path }) => path === "src/app.ts")?.radius,
    );
    expect(renamed.color).not.toBe(readme.color);
    expect(renamed.accessibleDescription).toContain(
      "renamed from src/old-app.ts",
    );
    expect(ghost).toMatchObject({
      kind: "ghost",
      parentId: "directory:src",
    });
    expect(ghost.accessibleDescription).toContain("deleted");
    expect(sourceDirectory.accessibleDescription).toContain(
      "2 changed descendants",
    );
    expect(sourceDirectory.color).not.toBe("#475569");
    expect(model.sizeLegend.label).toBe("File bytes");
    expect(model.colorLegend).toMatchObject({
      label: "Commit status / impact",
      minimum: "5 changed",
      maximum: "22 changed",
    });
  });
});
