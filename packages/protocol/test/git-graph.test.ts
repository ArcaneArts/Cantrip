import { describe, expect, it } from "vitest";

import {
  gitGraphCommitOverlaySchema,
  gitGraphMetricsSchema,
  gitGraphSnapshotSchema,
  workerCommandSchema,
} from "../src/index.js";

const revision = "a".repeat(40);

describe("Git graph protocol", () => {
  it("validates progressive snapshots and historical metrics", () => {
    const snapshot = gitGraphSnapshotSchema.parse({
      analyzerVersion: 1,
      revision,
      branch: "main",
      rootPath: null,
      rootId: "directory:.",
      totalNodes: 2,
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
          byteSize: 8,
          extension: null,
          language: null,
        },
        {
          id: "file:src/index.ts",
          path: "src/index.ts",
          parentId: "directory:src",
          name: "index.ts",
          kind: "file",
          objectId: "c".repeat(40),
          byteSize: 8,
          extension: "ts",
          language: "TypeScript",
        },
      ],
    });
    expect(snapshot.analysis.history).toBe("pending");

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
      nodes: [
        {
          nodeId: "file:src/index.ts",
          path: "src/index.ts",
          lineCount: 1,
          binary: false,
          commitTouches: 3,
          additions: 5,
          deletions: 2,
          churn: 7,
          binaryCommitTouches: 0,
          firstChangedAt: "2026-08-17T12:00:00.000Z",
          lastChangedAt: "2026-08-19T12:00:00.000Z",
          dominantAuthorName: null,
          dominantAuthorEmail: null,
          dominantAuthorShare: null,
          averageBlameAgeDays: null,
        },
      ],
    });
    expect(metrics.nodes[0]?.churn).toBe(7);
  });

  it("bounds graph paths, node counts, and commit overlays", () => {
    expect(
      gitGraphSnapshotSchema.safeParse({
        analyzerVersion: 1,
        revision: null,
        branch: "main",
        rootPath: "../outside",
        rootId: "directory:.",
        nodes: [],
        totalNodes: 0,
        truncated: false,
        analyzedAt: "2026-08-19T12:00:00.000Z",
        analysis: {
          structure: "ready",
          lines: "ready",
          history: "ready",
          blame: "unavailable",
        },
      }).success,
    ).toBe(false);

    const overlay = gitGraphCommitOverlaySchema.parse({
      revision,
      baseRevision: null,
      rootPath: "src",
      nodes: [
        {
          path: "src/deleted.ts",
          originalPath: null,
          status: "deleted",
          additions: 0,
          deletions: 12,
          weight: 12,
          binary: false,
          ghost: true,
        },
      ],
      filesChanged: 1,
      additions: 0,
      deletions: 12,
      truncated: false,
    });
    expect(overlay.nodes[0]).toMatchObject({ ghost: true, weight: 12 });
  });

  it("applies bounded defaults to worker graph commands", () => {
    expect(
      workerCommandSchema.parse({
        type: "git.graph.snapshot",
        cwd: "/repo",
      }),
    ).toEqual({
      type: "git.graph.snapshot",
      cwd: "/repo",
      revision: "HEAD",
      rootPath: null,
      maxNodes: 100_000,
    });
    expect(
      workerCommandSchema.safeParse({
        type: "git.graph.metrics",
        cwd: "/repo",
        rootPath: "../outside",
      }).success,
    ).toBe(false);
  });
});
