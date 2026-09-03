import type { GitCommit } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  comparisonForSelectedCommits,
  squashActionForSelectedCommits,
} from "./git-history-selection";

function commit(hash: string, parent: string | null): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 10),
    parents: parent ? [parent] : [],
    subject: hash,
    authorName: "Test",
    authorEmail: "test@example.test",
    authoredAt: "2026-09-03T00:00:00.000Z",
    refs: [],
    isHead: hash === "c".repeat(40),
  };
}

describe("Git History multi-selection", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  const commits = [commit(c, b), commit(b, a), commit(a, null)];

  it("orders comparison endpoints from older to newer", () => {
    expect(comparisonForSelectedCommits(commits, new Set([b, c]))).toEqual({
      left: b,
      right: c,
    });
  });

  it("builds a reviewed squash plan only for a contiguous range ending at HEAD", () => {
    expect(squashActionForSelectedCommits(commits, new Set([b, c]), c)).toEqual(
      {
        type: "interactiveRebase",
        upstreamRef: a,
        todo: [
          { action: "pick", revision: b, message: null },
          { action: "squash", revision: c, message: null },
        ],
      },
    );
    expect(
      squashActionForSelectedCommits(commits, new Set([a, b]), c),
    ).toBeNull();
  });
});
