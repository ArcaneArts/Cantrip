import { describe, expect, it } from "vitest";

import {
  workspaceRepositoryCandidateSummarySchema,
  workspaceRepositoryDiscoveryCommandSchema,
  workspaceRepositoryDiscoveryProgressSchema,
  workspaceRepositoryDiscoverySnapshotSchema,
  workspaceRepositoryDiscoveryStartSchema,
  workspaceRepositoryDiscoveryWorkerResultSchema,
  workspaceRepositoryImportStartSchema,
  workspaceRepositoryImportValidateCommandSchema,
  workspaceRepositoryImportValidationResultSchema,
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
        diagnosticCode: null,
        truncated: false,
      }),
    ).toEqual({ counts, diagnosticCode: null, truncated: false });
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
        diagnosticCode: null,
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
    expect(workspaceRepositoryCandidateSummarySchema.parse(candidate)).toEqual({
      ...candidate,
      conflict: null,
      importAttempt: 0,
      importError: null,
      projectId: null,
    });
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
        diagnosticCode: null,
        truncated: false,
      }),
    ).toThrow(/classification metadata/iu);

    expect(
      workspaceRepositoryDiscoveryWorkerResultSchema.parse({
        jobId: candidate.jobId,
        attempt: 1,
        candidates: [
          {
            path: handle,
            displayPath: handle,
            originUrl: null,
            github: null,
            repositoryFingerprint: candidate.repositoryFingerprint,
            classification: "unsupported",
            diagnosticCode: "bare-repository",
          },
        ],
        counts: {
          candidates: 1,
          collapsedRepositories: 0,
          rejectedRepositories: 1,
          scannedDirectories: 1,
          scannedEntries: 1,
          skippedSymlinks: 0,
          unreadableDirectories: 0,
        },
        diagnosticCode: null,
        truncated: false,
      }).candidates[0],
    ).toMatchObject({
      classification: "unsupported",
      diagnosticCode: "bare-repository",
    });
    expect(() =>
      workspaceRepositoryDiscoveryWorkerResultSchema.parse({
        jobId: candidate.jobId,
        attempt: 1,
        candidates: [
          {
            path: handle,
            displayPath: handle,
            originUrl: null,
            github: null,
            repositoryFingerprint: candidate.repositoryFingerprint,
            classification: "unsupported",
            diagnosticCode: null,
          },
        ],
        counts: {
          candidates: 1,
          collapsedRepositories: 0,
          rejectedRepositories: 1,
          scannedDirectories: 1,
          scannedEntries: 1,
          skippedSymlinks: 0,
          unreadableDirectories: 0,
        },
        diagnosticCode: null,
        truncated: false,
      }),
    ).toThrow(/classification metadata/iu);
  });

  it("defines protected, revision-fenced repository imports", () => {
    const handle = `ctrr_${"a".repeat(43)}`;
    const candidateId = "fe47e031-8924-44c0-9b51-677fc23397ca";
    expect(
      workspaceRepositoryImportStartSchema.parse({
        expectedStateRevision: 4,
        candidates: [
          {
            candidateId,
            projectId: "95ed0d89-a1d5-48ac-a1b7-67a2037f8373",
            nameProtection: {
              classification: { recordKind: "project" },
              protectedLabel: {
                formatVersion: 1,
                keyRevision: 1,
                envelope: {
                  version: 1,
                  algorithm: "AES-256-GCM",
                  keyRevision: 1,
                  nonce: "AAAAAAAAAAAAAAAA",
                  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
                },
              },
            },
            repositoryBlindIndex: null,
          },
        ],
      }).expectedStateRevision,
    ).toBe(4);
    expect(
      workspaceRepositoryImportValidateCommandSchema.parse({
        type: "workspace.repository-import.validate",
        candidateId,
        attempt: 1,
        rootPath: handle,
        path: handle,
        expectedRepositoryFingerprint: "b".repeat(64),
      }),
    ).toMatchObject({ rootPath: handle, path: handle });
    expect(
      workspaceRepositoryImportValidationResultSchema.parse({
        candidateId,
        attempt: 1,
        path: handle,
        displayPath: handle,
        originUrl: null,
        github: null,
        repositoryFingerprint: "b".repeat(64),
        classification: "local-git",
        diagnosticCode: null,
        branch: handle,
        head: "c".repeat(40),
      }).classification,
    ).toBe("local-git");
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
          diagnosticCode: null,
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

  it("requires explicit, consistent truncation and duplicate diagnostics", () => {
    const counts = {
      candidates: 0,
      collapsedRepositories: 0,
      rejectedRepositories: 0,
      scannedDirectories: 1,
      scannedEntries: 1,
      skippedSymlinks: 0,
      unreadableDirectories: 0,
    };
    expect(
      workspaceRepositoryDiscoveryProgressSchema.parse({
        counts,
        diagnosticCode: "scan-truncated",
        truncated: true,
      }).diagnosticCode,
    ).toBe("scan-truncated");
    expect(() =>
      workspaceRepositoryDiscoveryProgressSchema.parse({
        counts,
        diagnosticCode: null,
        truncated: true,
      }),
    ).toThrow(/truncation metadata/iu);
    expect(
      workspaceRepositoryDiscoveryWorkerResultSchema.parse({
        jobId: "72b3b25e-dd0f-4a12-bef5-1a77cc064219",
        attempt: 1,
        candidates: [],
        counts,
        diagnosticCode: "scan-truncated",
        truncated: true,
      }).diagnosticCode,
    ).toBe("scan-truncated");

    const candidate = {
      id: "fe47e031-8924-44c0-9b51-677fc23397ca",
      jobId: "72b3b25e-dd0f-4a12-bef5-1a77cc064219",
      workspaceId: "workspace-one",
      workerId: "worker-one",
      pathHandle: `ctrr_${"a".repeat(43)}`,
      displayHandle: `ctrr_${"b".repeat(43)}`,
      originUrlHandle: null,
      github: null,
      repositoryFingerprint: "c".repeat(64),
      classification: "local-git",
      importState: "pending",
      diagnosticCode: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(
      workspaceRepositoryCandidateSummarySchema.parse({
        ...candidate,
        conflict: {
          code: "duplicate-checkout",
          kind: "checkout",
          projectId: "95ed0d89-a1d5-48ac-a1b7-67a2037f8373",
          workspaceId: "workspace-two",
        },
      }).conflict?.code,
    ).toBe("duplicate-checkout");
    expect(() =>
      workspaceRepositoryCandidateSummarySchema.parse({
        ...candidate,
        conflict: {
          code: "duplicate-github",
          kind: "checkout",
          projectId: "95ed0d89-a1d5-48ac-a1b7-67a2037f8373",
          workspaceId: "workspace-two",
        },
      }),
    ).toThrow();
  });
});
