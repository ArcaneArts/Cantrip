import type { WorkspaceRepositoryCandidateSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  defaultWorkspaceRepositorySelection,
  workspaceRepositoryCandidateCanImport,
  workspaceRepositoryCandidateClassificationLabel,
  workspaceRepositoryCandidateDiagnosticLabel,
  workspaceRepositoryCandidateGithub,
  workspaceRepositoryCandidateIsVisible,
  workspaceRepositoryCandidateName,
  type ResolvedWorkspaceRepositoryCandidate,
} from "./workspace-repository-discovery-review";

const handle = `ctrr_${"a".repeat(43)}`;

function resolved(
  overrides: Partial<WorkspaceRepositoryCandidateSummary> = {},
): ResolvedWorkspaceRepositoryCandidate {
  return {
    candidate: {
      id: "fe47e031-8924-44c0-9b51-677fc23397ca",
      jobId: "72b3b25e-dd0f-4a12-bef5-1a77cc064219",
      workspaceId: "workspace-one",
      workerId: "worker-one",
      pathHandle: handle,
      displayHandle: handle,
      originUrlHandle: null,
      github: null,
      repositoryFingerprint: "b".repeat(64),
      classification: "local-git",
      importState: "pending",
      importAttempt: 0,
      importError: null,
      projectId: null,
      conflict: null,
      diagnosticCode: null,
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:00.000Z",
      ...overrides,
    },
    displayPath: "team\\Sentinel.git",
    originUrl: null,
    github: null,
  };
}

describe("workspace repository import review", () => {
  it("derives portable names and permits unresolved local candidates", () => {
    const candidate = resolved();
    expect(workspaceRepositoryCandidateName(candidate)).toBe("Sentinel");
    expect(workspaceRepositoryCandidateGithub(candidate)).toBeNull();
    expect(workspaceRepositoryCandidateCanImport(candidate)).toBe(true);
  });

  it("requires resolved GitHub identity and disables registered checkouts", () => {
    const candidate = resolved({
      classification: "github-accessible",
      github: {
        repositoryId: handle,
        nameWithOwner: handle,
        url: handle,
      },
      originUrlHandle: handle,
    });
    expect(workspaceRepositoryCandidateCanImport(candidate)).toBe(false);
    candidate.github = {
      repositoryId: "123",
      nameWithOwner: "ArcaneArts/Sentinel",
      url: "https://github.com/ArcaneArts/Sentinel",
    };
    expect(workspaceRepositoryCandidateGithub(candidate)).toEqual(
      candidate.github,
    );
    expect(workspaceRepositoryCandidateCanImport(candidate)).toBe(true);
    candidate.candidate.conflict = {
      code: "duplicate-checkout",
      kind: "checkout",
      projectId: "95ed0d89-a1d5-48ac-a1b7-67a2037f8373",
      workspaceId: "workspace-two",
    };
    expect(workspaceRepositoryCandidateCanImport(candidate)).toBe(false);
  });

  it("labels unsupported checkout types and keeps them out of imports", () => {
    const bare = resolved({
      classification: "unsupported",
      diagnosticCode: "bare-repository",
    });
    expect(workspaceRepositoryCandidateCanImport(bare)).toBe(false);
    expect(
      workspaceRepositoryCandidateClassificationLabel(
        bare.candidate.classification,
      ),
    ).toBe("Unsupported checkout");
    expect(
      workspaceRepositoryCandidateDiagnosticLabel(
        bare.candidate.diagnosticCode,
      ),
    ).toBe("Bare repositories cannot be imported automatically.");
    expect(workspaceRepositoryCandidateDiagnosticLabel("linked-worktree")).toBe(
      "Non-primary linked worktrees cannot be imported automatically.",
    );
  });

  it("defaults accessible GitHub repositories and keeps local repositories opt-in", () => {
    const local = resolved();
    const github = resolved({
      id: "6140c772-84bd-4e75-b335-2d58ccabf763",
      classification: "github-accessible",
      github: {
        repositoryId: handle,
        nameWithOwner: handle,
        url: handle,
      },
      originUrlHandle: handle,
    });
    github.github = {
      repositoryId: "123",
      nameWithOwner: "ArcaneArts/Sentinel",
      url: "https://github.com/ArcaneArts/Sentinel",
    };

    expect(defaultWorkspaceRepositorySelection([local, github])).toEqual(
      new Set([github.candidate.id]),
    );
  });

  it("hides repositories already imported or registered elsewhere", () => {
    const imported = resolved({ importState: "imported" });
    const conflict = resolved({
      conflict: {
        code: "duplicate-checkout",
        kind: "checkout",
        projectId: "95ed0d89-a1d5-48ac-a1b7-67a2037f8373",
        workspaceId: "workspace-two",
      },
    });

    expect(workspaceRepositoryCandidateIsVisible(resolved())).toBe(true);
    expect(workspaceRepositoryCandidateIsVisible(imported)).toBe(false);
    expect(workspaceRepositoryCandidateIsVisible(conflict)).toBe(false);
  });
});
