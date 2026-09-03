import type { GithubIssueSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  activeGithubMention,
  containsGithubReference,
  expandGithubReferences,
  filterGithubReferences,
  insertGithubMention,
  type GithubReference,
} from "./github-mentions";

function reference(
  number: number,
  title: string,
  kind: GithubReference["kind"] = "issue",
  state: GithubIssueSummary["state"] = "open",
): GithubReference {
  return {
    author: "octocat",
    closedAt: state === "closed" ? "2026-08-20T00:00:00.000Z" : null,
    commentCount: 0,
    createdAt: "2026-08-19T00:00:00.000Z",
    kind,
    labels: [],
    assignees: [],
    milestone: null,
    number,
    state,
    title,
    updatedAt: "2026-08-21T00:00:00.000Z",
    url: `https://github.com/ArcaneArts/Cantrip/${kind === "pull-request" ? "pull" : "issues"}/${number}`,
  };
}

const references = [
  reference(123, "Bug: composer loses its selection"),
  reference(456, "Fix GitHub issue suggestions", "pull-request"),
  reference(12, "Older bug", "issue", "closed"),
];

describe("GitHub mentions", () => {
  it("finds the hash token at the caret and stops after whitespace", () => {
    expect(activeGithubMention("Please inspect #Bug", 19)).toEqual({
      start: 15,
      end: 19,
      query: "Bug",
    });
    expect(activeGithubMention("Please inspect #Bug now", 23)).toBeNull();
    expect(activeGithubMention("not#an-issue", 12)).toBeNull();
  });

  it("matches titles and number prefixes while preferring exact numbers", () => {
    expect(
      filterGithubReferences(references, "bug").map(({ number }) => number),
    ).toEqual([123, 12]);
    expect(
      filterGithubReferences(references, "12").map(({ number }) => number),
    ).toEqual([12, 123]);
  });

  it("replaces the active token with the selected number and a space", () => {
    const mention = activeGithubMention("Please inspect #Bug", 19);
    expect(mention).not.toBeNull();
    expect(
      insertGithubMention("Please inspect #Bug", mention!, references[0]!),
    ).toEqual({ text: "Please inspect #123 ", caret: 20 });
  });

  it("expands only accepted references into titled Markdown links", () => {
    expect(
      expandGithubReferences("Fix #123 and #456.", [
        references[0]!,
        references[1]!,
      ]),
    ).toBe(
      "Fix [Issue #123: Bug: composer loses its selection](https://github.com/ArcaneArts/Cantrip/issues/123) and [PR #456: Fix GitHub issue suggestions](https://github.com/ArcaneArts/Cantrip/pull/456).",
    );
    expect(expandGithubReferences("Keep #12 plain.", [references[0]!])).toBe(
      "Keep #12 plain.",
    );
    expect(containsGithubReference("Keep #123 selected.", references[0]!)).toBe(
      true,
    );
    expect(containsGithubReference("Keep #1234 plain.", references[0]!)).toBe(
      false,
    );
  });
});
