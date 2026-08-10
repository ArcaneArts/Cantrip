import type { GitManagedOperationRecord } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  gitOperationControlActions,
  gitOperationEditorRef,
  gitOperationIsActive,
  gitOperationSourceLabel,
} from "./git-operation-panel";

function operation(
  state: GitManagedOperationRecord["state"],
  type: GitManagedOperationRecord["type"] = "rebase",
): GitManagedOperationRecord {
  return {
    id: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
    projectId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f3",
    worktreeId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f4",
    workerId: "local-worker",
    type,
    state,
    originalHead: "1".repeat(40),
    currentHead: "1".repeat(40),
    sourceRef: "origin/main",
    sourceRevision: "2".repeat(40),
    targetRef: "refs/heads/feature",
    targetRevision: "1".repeat(40),
    pendingCommits: ["3".repeat(40)],
    currentStep: 1,
    totalSteps: 1,
    conflictedPaths: [],
    output: "",
    checkpointRef: "refs/cantrip/checkpoints/rebase-test",
    error: null,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    completedAt: null,
  };
}

describe("Git operation panel state", () => {
  it("keeps reconnectable operation states active", () => {
    expect(gitOperationIsActive(operation("running"))).toBe(true);
    expect(gitOperationIsActive(operation("conflicted"))).toBe(true);
    expect(gitOperationIsActive(operation("completed"))).toBe(false);
  });

  it("only offers skip for sequencers that support it", () => {
    expect(
      gitOperationControlActions(operation("conflicted", "merge")),
    ).toEqual(["continue", "abort"]);
    expect(
      gitOperationControlActions(operation("conflicted", "rebase")),
    ).toEqual(["continue", "skip", "abort"]);
    expect(
      gitOperationControlActions(operation("conflicted", "stash")),
    ).toEqual(["continue", "abort"]);
    expect(gitOperationControlActions(operation("completed"))).toEqual([]);
  });

  it("formats internal stash metadata for people", () => {
    const stash = operation("conflicted", "stash");
    stash.sourceRef = "pop:stash@{0}";
    expect(gitOperationSourceLabel(stash)).toBe("pop stash@{0}");
  });

  it("uses the upstream field for interactive rewrite planning", () => {
    expect(
      gitOperationEditorRef({
        type: "interactiveRebase",
        upstreamRef: "origin/main",
        todo: [],
      }),
    ).toBe("origin/main");
    expect(gitOperationEditorRef({ type: "merge", sourceRef: "feature" })).toBe(
      "feature",
    );
  });
});
