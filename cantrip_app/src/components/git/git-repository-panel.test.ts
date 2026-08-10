import type { GitTagSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  filterRepositoryTags,
  remoteActionDescription,
} from "./git-repository-panel";

const tag: GitTagSummary = {
  name: "v1.2.3",
  hash: "2".repeat(40),
  targetHash: "1".repeat(40),
  targetType: "commit",
  annotated: true,
  subject: "Stable Cantrip release",
  taggerName: "Cantrip",
  createdAt: "2026-08-10T12:00:00.000Z",
  signature: {
    status: "valid",
    signer: "Cantrip",
    key: "ABC123",
    fingerprint: "DEF456",
  },
  publishedRemotes: ["origin"],
};

describe("repository Git controls", () => {
  it("filters tags by name, subject, and target hash", () => {
    expect(filterRepositoryTags([tag], "1.2")).toEqual([tag]);
    expect(filterRepositoryTags([tag], "stable")).toEqual([tag]);
    expect(filterRepositoryTags([tag], "111111")).toEqual([tag]);
    expect(filterRepositoryTags([tag], "missing")).toEqual([]);
  });

  it("describes remote defaults and destructive pruning clearly", () => {
    expect(
      remoteActionDescription({
        type: "setDefaults",
        fetchRemote: "upstream",
        pushRemote: "origin",
      }),
    ).toContain("upstream");
    expect(
      remoteActionDescription({
        type: "fetch",
        remote: "origin",
        prune: true,
      }),
    ).toBe("Fetch and prune origin.");
  });
});
