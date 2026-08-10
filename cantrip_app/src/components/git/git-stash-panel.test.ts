import type { GitStashSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  prependCreatedStash,
  stashActionDescription,
  stashAge,
} from "./git-stash-panel";

function stash(hashCharacter: string, ref: string): GitStashSummary {
  return {
    ref,
    hash: hashCharacter.repeat(40),
    shortHash: hashCharacter.repeat(8),
    message: `stash-${hashCharacter}`,
    createdAt: "2026-08-10T12:00:00.000Z",
    baseHash: "b".repeat(40),
    files: [],
    filesChanged: 0,
    filesTruncated: false,
    additions: 0,
    deletions: 0,
    includesUntracked: false,
  };
}

describe("Git stash panel state", () => {
  it("prepends authoritative creations without duplicating cached entries", () => {
    const created = stash("a", "stash@{0}");
    const previous = stash("c", "stash@{1}");
    expect(
      prependCreatedStash(
        { stashes: [previous, created], truncated: true },
        created,
      ),
    ).toEqual({ stashes: [created, previous], truncated: true });
  });

  it("makes destructive and recoverable action effects explicit", () => {
    expect(stashActionDescription({ type: "clear" })).toMatch(/permanently/iu);
    expect(
      stashActionDescription({
        type: "pop",
        ref: "stash@{0}",
        hash: "a".repeat(40),
      }),
    ).toMatch(/only if Git succeeds/u);
    expect(
      stashActionDescription({
        type: "branch",
        ref: "stash@{0}",
        hash: "a".repeat(40),
        branch: "review/stash",
      }),
    ).toContain("review/stash");
  });

  it("formats recent stash ages compactly", () => {
    expect(
      stashAge(
        "2026-08-10T11:59:30.000Z",
        Date.parse("2026-08-10T12:00:00.000Z"),
      ),
    ).toContain("30 seconds");
  });
});
