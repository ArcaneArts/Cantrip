import type { ProjectWorktreeSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  commitActionFromEditor,
  eligibleCommitActionWorktrees,
  type CommitActionEditor,
  type CommitActionRequest,
} from "./git-commit-action-dialog";

function worktree(
  id: string,
  overrides: Partial<ProjectWorktreeSummary> = {},
): ProjectWorktreeSummary {
  return {
    id,
    projectSourceId: "source-one",
    projectId: "project-one",
    rootKind: "git-worktree",
    workerId: "worker-one",
    name: id,
    path: `/tmp/${id}`,
    displayPath: `/tmp/${id}`,
    isPrimary: id === "primary",
    isDefault: id === "primary",
    origin: "cantrip",
    lifecycleState: "ready",
    branch: id,
    head: "a".repeat(40),
    detached: false,
    locked: false,
    lockReason: null,
    lastScannedAt: null,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    ...overrides,
  };
}

const hash = "1".repeat(40);
const target = {
  hash,
  shortHash: hash.slice(0, 8),
  subject: "Selected commit",
  parents: ["2".repeat(40), "3".repeat(40)],
  isHead: false,
};
const editor: CommitActionEditor = {
  range: false,
  fromRevision: hash,
  toRevision: hash,
  mainlineParent: 1,
  message: "",
};

describe("commit action dialog", () => {
  it("builds inclusive range and single cherry-pick actions", () => {
    const request: CommitActionRequest = { kind: "cherryPick", target };
    expect(commitActionFromEditor(request, editor)).toEqual({
      type: "cherryPick",
      selection: { type: "commits", revisions: [hash] },
    });
    expect(
      commitActionFromEditor(request, {
        ...editor,
        range: true,
        fromRevision: "4".repeat(40),
        toRevision: "5".repeat(40),
      }),
    ).toEqual({
      type: "cherryPick",
      selection: {
        type: "range",
        fromRevision: "4".repeat(40),
        toRevision: "5".repeat(40),
      },
    });
  });

  it("keeps merge mainline and optional amend message explicit", () => {
    expect(
      commitActionFromEditor({ kind: "revert", target }, editor),
    ).toMatchObject({
      type: "revert",
      revision: hash,
      mainlineParent: 1,
    });
    expect(
      commitActionFromEditor(
        { kind: "amend", target: { ...target, isHead: true } },
        { ...editor, message: "  Revised message  " },
      ),
    ).toEqual({ type: "amend", message: "Revised message" });
  });

  it("offers only ready worktrees from the same source and worker", () => {
    expect(
      eligibleCommitActionWorktrees("current", [
        worktree("other"),
        worktree("different-source", { projectSourceId: "source-two" }),
        worktree("different-worker", { workerId: "worker-two" }),
        worktree("creating", { lifecycleState: "creating" }),
        worktree("current"),
      ]).map(({ id }) => id),
    ).toEqual(["current", "other"]);
  });
});
