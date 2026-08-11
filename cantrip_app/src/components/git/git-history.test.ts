import type {
  GitCommit,
  GitStatus,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  buildHistoryDisplayRows,
  graphCurvePath,
  graphRows,
} from "./git-history";
import { historyWorktreeState } from "./history-worktree-marker";

const head = "1".repeat(40);
const parent = "2".repeat(40);
const commits: GitCommit[] = [
  {
    hash: head,
    shortHash: head.slice(0, 7),
    parents: [parent],
    subject: "Head",
    authorName: "Cantrip",
    authorEmail: "test@cantrip.art",
    authoredAt: "2026-08-08T12:00:00.000Z",
    refs: [],
    isHead: true,
  },
  {
    hash: parent,
    shortHash: parent.slice(0, 7),
    parents: [],
    subject: "Parent",
    authorName: "Cantrip",
    authorEmail: "test@cantrip.art",
    authoredAt: "2026-08-07T12:00:00.000Z",
    refs: [],
    isHead: false,
  },
];

function worktree(
  id: string,
  input: Partial<ProjectWorktreeSummary> = {},
): ProjectWorktreeSummary {
  return {
    id,
    projectSourceId: "source-1",
    projectId: "project-1",
    workerId: "worker-1",
    name: id,
    path: `/tmp/${id}`,
    displayPath: id,
    isPrimary: false,
    isDefault: false,
    origin: "agent",
    lifecycleState: "ready",
    branch: id,
    head,
    detached: false,
    locked: false,
    lockReason: null,
    lastScannedAt: "2026-08-08T12:00:00.000Z",
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    ...input,
  };
}

const clean: GitStatus = {
  branch: "main",
  head,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [],
  branches: [],
};

describe("worktree history rows", () => {
  it("attaches multiple worktree markers to a shared HEAD", () => {
    const graph = graphRows(commits);
    const rows = buildHistoryDisplayRows(
      graph.rows,
      [worktree("agent-one"), worktree("agent-two")],
      { "agent-one": clean, "agent-two": clean },
    );
    expect(rows[0]).toMatchObject({
      kind: "commit",
      worktrees: [{ id: "agent-one" }, { id: "agent-two" }],
    });
  });

  it("places every dirty worktree WIP row immediately before its HEAD", () => {
    const dirty = {
      ...clean,
      files: [
        {
          path: "README.md",
          originalPath: null,
          indexStatus: "M",
          worktreeStatus: " ",
          staged: true,
          unstaged: false,
        },
      ],
    } satisfies GitStatus;
    const graph = graphRows(commits);
    const rows = buildHistoryDisplayRows(
      graph.rows,
      [worktree("dirty-one"), worktree("dirty-two")],
      { "dirty-one": dirty, "dirty-two": dirty },
    );
    expect(rows.slice(0, 3).map(({ kind }) => kind)).toEqual([
      "wip",
      "wip",
      "commit",
    ]);
    expect(rows[0]?.graph.lane).toBe(rows[2]?.graph.lane);
    expect(rows[1]?.graph.lane).toBe(rows[2]?.graph.lane);
  });

  it("distinguishes dirty conflicts and unavailable worktrees", () => {
    const conflict = {
      ...clean,
      files: [
        {
          path: "conflict.txt",
          originalPath: null,
          indexStatus: "U",
          worktreeStatus: "U",
          staged: true,
          unstaged: true,
        },
      ],
    } satisfies GitStatus;
    expect(
      historyWorktreeState({
        online: true,
        status: conflict,
        worktree: worktree("conflict"),
      }),
    ).toEqual({ conflict: true, dirty: true, unavailable: false });
    expect(
      historyWorktreeState({
        online: false,
        status: clean,
        worktree: worktree("offline"),
      }).unavailable,
    ).toBe(true);
  });
});

describe("commit graph layout", () => {
  const commit = (hash: string, parents: string[]): GitCommit => ({
    hash,
    shortHash: hash,
    parents,
    subject: hash,
    authorName: "Cantrip",
    authorEmail: "test@cantrip.art",
    authoredAt: "2026-08-08T12:00:00.000Z",
    refs: [],
    isHead: false,
  });

  it("keeps unaffected lanes stationary when a neighboring lane ends", () => {
    const rows = graphRows([
      commit("a", ["b"]),
      commit("x", ["y"]),
      commit("b", []),
      commit("y", []),
    ]).rows;

    expect(rows[2]?.passthrough).toContainEqual({
      color: rows[3]?.nodeColor,
      from: 1,
      to: 1,
    });
    expect(rows[3]?.lane).toBe(1);
  });

  it("preserves an existing lane color when another branch joins it", () => {
    const rows = graphRows([
      commit("a", ["b"]),
      commit("x", ["b"]),
      commit("b", []),
    ]).rows;

    expect(rows[2]?.nodeColor).toBe(rows[0]?.nodeColor);
    expect(rows[2]?.nodeColor).not.toBe(rows[1]?.nodeColor);
    expect(rows[1]?.edges[0]?.color).toBe(rows[1]?.nodeColor);
  });

  it("uses straight segments and symmetric curves between rows", () => {
    expect(graphCurvePath(10, 10, -1, 33)).toBe("M 10 -1 L 10 33");
    expect(graphCurvePath(10, 26, -1, 33)).toBe(
      "M 10 -1 C 10 16, 26 16, 26 33",
    );
    expect(graphCurvePath(10, 26, 16, 33)).toBe(
      "M 10 16 C 10 24.5, 26 24.5, 26 33",
    );
  });
});
