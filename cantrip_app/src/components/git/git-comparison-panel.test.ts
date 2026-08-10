import type { GitRevisionCandidate } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  comparisonDirectionLabel,
  filterRevisionCandidates,
} from "./git-comparison-panel";

const candidate = (
  name: string,
  kind: GitRevisionCandidate["kind"],
  hashCharacter: string,
): GitRevisionCandidate => ({
  revision: hashCharacter.repeat(40),
  hash: hashCharacter.repeat(40),
  shortHash: hashCharacter.repeat(10),
  name,
  kind,
  current: false,
  worktreeId: kind === "worktree" ? `worktree-${name}` : null,
  worktreeName: kind === "worktree" ? name : null,
});

describe("Git comparison selection", () => {
  const candidates = [
    candidate("main", "local", "a"),
    candidate("origin/release", "remote", "b"),
    candidate("Agent review worktree", "worktree", "c"),
    candidate("v1.0.0", "tag", "d"),
  ];

  it("searches names, kinds, and hashes while bounding visible results", () => {
    expect(filterRevisionCandidates(candidates, "release")[0]?.name).toBe(
      "origin/release",
    );
    expect(filterRevisionCandidates(candidates, "worktree")[0]?.name).toBe(
      "Agent review worktree",
    );
    expect(filterRevisionCandidates(candidates, "dddd")[0]?.name).toBe(
      "v1.0.0",
    );
    expect(
      filterRevisionCandidates(
        Array.from({ length: 150 }, (_, index) =>
          candidate(`branch-${index}`, "local", "a"),
        ),
        "",
      ),
    ).toHaveLength(100);
  });

  it("makes direct and merge-base comparison direction explicit", () => {
    expect(comparisonDirectionLabel("direct")).toContain("A → B");
    expect(comparisonDirectionLabel("merge-base")).toContain(
      "merge-base(A, B) → B",
    );
  });
});
