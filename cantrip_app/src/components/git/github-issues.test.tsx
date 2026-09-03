import type { GithubIssueSummary } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GithubIssueMobileCard } from "./github-issues";

const issue = {
  number: 42,
  title: "Make the GitHub surface work on narrow screens",
  state: "open",
  url: "https://github.com/ArcaneArts/Cantrip/issues/42",
  author: "cantrip-user",
  commentCount: 7,
  labels: [
    { name: "mobile", color: "22d3ee" },
    { name: "git", color: "3b82f6" },
    { name: "ux", color: "a855f7" },
    { name: "priority", color: "f59e0b" },
  ],
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-03T12:00:00.000Z",
  closedAt: null,
} satisfies GithubIssueSummary;

describe("GitHub issue mobile card", () => {
  it("keeps metadata and labels in a bounded card instead of a wide table row", () => {
    const markup = renderToStaticMarkup(
      <GithubIssueMobileCard issue={issue} onSelect={vi.fn()} />,
    );

    expect(markup).toContain(issue.title);
    expect(markup).toContain("#42");
    expect(markup).toContain("@cantrip-user");
    expect(markup).toContain("+1");
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("overflow-hidden");
    expect(markup).not.toContain("min-w-[680px]");
  });
});
