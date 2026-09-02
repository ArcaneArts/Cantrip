import { describe, expect, it } from "vitest";

import {
  workspaceRepositoryCandidateSummarySchema,
  workspaceRepositoryDiscoverySnapshotSchema,
  workspaceRepositoryDiscoveryStartSchema,
} from "./workspace-repository-discovery.js";

const now = "2026-09-02T12:00:00.000Z";

describe("workspace repository discovery contracts", () => {
  it("defaults manual scans to depth three and rejects plaintext candidate paths", () => {
    expect(workspaceRepositoryDiscoveryStartSchema.parse({})).toEqual({
      depth: 3,
    });
    expect(() =>
      workspaceRepositoryCandidateSummarySchema.parse({
        id: "fe47e031-8924-44c0-9b51-677fc23397ca",
        jobId: "72b3b25e-dd0f-4a12-bef5-1a77cc064219",
        workspaceId: "workspace-one",
        workerId: "worker-one",
        pathHandle: "/private/repository",
        displayHandle: `ctrr_${"a".repeat(43)}`,
        repositoryFingerprint: "b".repeat(64),
        classification: "unclassified",
        importState: "pending",
        diagnosticCode: null,
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow();
  });

  it("parses a completed durable snapshot", () => {
    expect(
      workspaceRepositoryDiscoverySnapshotSchema.parse({
        job: {
          id: "72b3b25e-dd0f-4a12-bef5-1a77cc064219",
          workspaceId: "workspace-one",
          workerId: "worker-one",
          state: "succeeded",
          stateRevision: 3,
          attempt: 1,
          depth: 3,
          truncated: false,
          counts: {
            candidates: 0,
            collapsedRepositories: 0,
            rejectedRepositories: 0,
            scannedDirectories: 1,
            scannedEntries: 0,
            skippedSymlinks: 0,
            unreadableDirectories: 0,
          },
          error: null,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          completedAt: now,
        },
        candidates: [],
      }).job.state,
    ).toBe("succeeded");
  });
});
