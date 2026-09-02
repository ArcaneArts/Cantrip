import { describe, expect, it } from "vitest";

import {
  workspaceRepositoryCandidateSummarySchema,
  workspaceRepositoryDiscoveryCommandSchema,
  workspaceRepositoryDiscoveryProgressSchema,
  workspaceRepositoryDiscoverySnapshotSchema,
  workspaceRepositoryDiscoveryStartSchema,
  workspaceRepositoryDiscoveryWorkerResultSchema,
} from "./workspace-repository-discovery.js";

const now = "2026-09-02T12:00:00.000Z";

describe("workspace repository discovery contracts", () => {
  it("defines protected bounded worker discovery messages", () => {
    const jobId = "72b3b25e-dd0f-4a12-bef5-1a77cc064219";
    const handle = `ctrr_${"a".repeat(43)}`;
    const counts = {
      candidates: 1,
      collapsedRepositories: 0,
      rejectedRepositories: 0,
      scannedDirectories: 4,
      scannedEntries: 12,
      skippedSymlinks: 0,
      unreadableDirectories: 0,
    };
    expect(
      workspaceRepositoryDiscoveryCommandSchema.parse({
        type: "workspace.repositories.discover",
        jobId,
        attempt: 1,
        rootPath: handle,
        depth: 3,
      }),
    ).toMatchObject({ rootPath: handle, depth: 3 });
    expect(
      workspaceRepositoryDiscoveryProgressSchema.parse({
        counts,
        truncated: false,
      }),
    ).toEqual({ counts, truncated: false });
    expect(
      workspaceRepositoryDiscoveryWorkerResultSchema.parse({
        jobId,
        attempt: 1,
        candidates: [
          {
            path: handle,
            displayPath: `ctrr_${"b".repeat(43)}`,
            originUrl: null,
            github: null,
            repositoryFingerprint: "c".repeat(64),
            classification: "local-git",
            diagnosticCode: null,
          },
        ],
        counts,
        truncated: false,
      }).candidates,
    ).toHaveLength(1);
  });

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
        originUrlHandle: null,
        github: null,
        repositoryFingerprint: "b".repeat(64),
        classification: "unclassified",
        importState: "pending",
        diagnosticCode: null,
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow();
  });

  it("requires protected metadata consistent with candidate classification", () => {
    const handle = `ctrr_${"a".repeat(43)}`;
    const candidate = {
      id: "fe47e031-8924-44c0-9b51-677fc23397ca",
      jobId: "72b3b25e-dd0f-4a12-bef5-1a77cc064219",
      workspaceId: "workspace-one",
      workerId: "worker-one",
      pathHandle: handle,
      displayHandle: handle,
      originUrlHandle: handle,
      github: {
        repositoryId: handle,
        nameWithOwner: handle,
        url: handle,
      },
      repositoryFingerprint: "b".repeat(64),
      classification: "github-accessible" as const,
      importState: "pending" as const,
      diagnosticCode: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(workspaceRepositoryCandidateSummarySchema.parse(candidate)).toEqual(
      candidate,
    );
    expect(() =>
      workspaceRepositoryCandidateSummarySchema.parse({
        ...candidate,
        github: null,
      }),
    ).toThrow(/classification metadata/iu);
    expect(() =>
      workspaceRepositoryDiscoveryWorkerResultSchema.parse({
        jobId: candidate.jobId,
        attempt: 1,
        candidates: [
          {
            path: handle,
            displayPath: handle,
            originUrl: handle,
            github: null,
            repositoryFingerprint: candidate.repositoryFingerprint,
            classification: "github-unavailable",
            diagnosticCode: null,
          },
        ],
        counts: {
          candidates: 1,
          collapsedRepositories: 0,
          rejectedRepositories: 0,
          scannedDirectories: 1,
          scannedEntries: 1,
          skippedSymlinks: 0,
          unreadableDirectories: 0,
        },
        truncated: false,
      }),
    ).toThrow(/classification metadata/iu);
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
