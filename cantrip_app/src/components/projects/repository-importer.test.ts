import { describe, expect, it } from "vitest";

import {
  nextRepositoryImportRenderCount,
  REPOSITORY_IMPORT_PAGE_SIZE,
  shouldLoadMoreRepositories,
} from "./repository-importer";

describe("repository importer pagination", () => {
  it("adds repositories in bounded pages without exceeding the result set", () => {
    expect(nextRepositoryImportRenderCount(100, 700)).toBe(200);
    expect(nextRepositoryImportRenderCount(650, 700)).toBe(700);
    expect(nextRepositoryImportRenderCount(100, 42)).toBe(42);
    expect(REPOSITORY_IMPORT_PAGE_SIZE).toBe(100);
  });

  it("loads another page only near the bottom while results remain", () => {
    expect(
      shouldLoadMoreRepositories({
        clientHeight: 600,
        renderedCount: 100,
        scrollHeight: 4_000,
        scrollTop: 4_000 - 600 - 480,
        totalCount: 700,
      }),
    ).toBe(true);
    expect(
      shouldLoadMoreRepositories({
        clientHeight: 600,
        renderedCount: 100,
        scrollHeight: 4_000,
        scrollTop: 4_000 - 600 - 481,
        totalCount: 700,
      }),
    ).toBe(false);
    expect(
      shouldLoadMoreRepositories({
        clientHeight: 600,
        renderedCount: 700,
        scrollHeight: 4_000,
        scrollTop: 3_400,
        totalCount: 700,
      }),
    ).toBe(false);
  });
});
