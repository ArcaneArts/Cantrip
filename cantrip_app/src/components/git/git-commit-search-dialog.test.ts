import { describe, expect, it } from "vitest";

import {
  flattenCommitSearchPages,
  normalizeCommitSearch,
} from "./git-commit-search-dialog";

describe("commit search form", () => {
  it("normalizes empty fields and maps one revision scope", () => {
    expect(
      normalizeCommitSearch({
        author: " Ada ",
        dateFrom: "",
        dateTo: "",
        hash: " ABCD1234 ",
        message: " race ",
        path: " src/index.ts ",
        ref: " main ",
        scope: "branch",
      }),
    ).toEqual({
      author: "Ada",
      branch: "main",
      dateFrom: null,
      dateTo: null,
      hash: "abcd1234",
      message: "race",
      path: "src/index.ts",
      tag: null,
    });
    expect(
      normalizeCommitSearch({
        author: "",
        dateFrom: "",
        dateTo: "",
        hash: "",
        message: "",
        path: "",
        ref: "",
        scope: "all",
      }),
    ).toBeNull();
  });

  it("preserves worker page ordering", () => {
    const query = {
      author: null,
      branch: null,
      dateFrom: null,
      dateTo: null,
      hash: null,
      message: "fix",
      path: null,
      tag: null,
    };
    const commit = (hash: string) => ({
      hash: hash.repeat(40),
      shortHash: hash.repeat(8),
      parents: [],
      subject: hash,
      authorName: "Cantrip Test",
      authorEmail: "test@cantrip.art",
      authoredAt: "2026-08-10T12:00:00.000Z",
      refs: [],
      isHead: false,
    });
    expect(
      flattenCommitSearchPages([
        {
          query,
          commits: [commit("1")],
          hasMore: true,
          nextCursor: 1,
        },
        {
          query,
          commits: [commit("2")],
          hasMore: false,
          nextCursor: null,
        },
      ]).map(({ subject }) => subject),
    ).toEqual(["1", "2"]);
  });
});
