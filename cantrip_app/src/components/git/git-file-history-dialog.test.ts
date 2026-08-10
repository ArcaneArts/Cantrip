import type { GitFileHistory } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { flattenFileHistoryPages } from "./git-file-history-dialog";

describe("file history pagination", () => {
  it("keeps commit order while flattening worker-authored pages", () => {
    const entry = (hash: string, subject: string) => ({
      hash: hash.repeat(40),
      shortHash: hash.repeat(8),
      subject,
      authorName: "Cantrip Test",
      authorEmail: "test@cantrip.art",
      authoredAt: "2026-08-10T12:00:00.000Z",
    });
    const pages = [
      {
        path: "README.md",
        revision: "1".repeat(40),
        commits: [entry("1", "Newest")],
        hasMore: true,
        nextCursor: 1,
      },
      {
        path: "README.md",
        revision: "1".repeat(40),
        commits: [entry("2", "Older")],
        hasMore: false,
        nextCursor: null,
      },
    ] satisfies GitFileHistory[];
    expect(
      flattenFileHistoryPages(pages).map(({ subject }) => subject),
    ).toEqual(["Newest", "Older"]);
  });
});
