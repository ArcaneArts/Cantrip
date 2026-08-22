import { describe, expect, it } from "vitest";

import { normalizeSyntheticBuildError } from "./synthetic-build";

describe("normalizeSyntheticBuildError", () => {
  it("preserves native structured errors", () => {
    expect(
      normalizeSyntheticBuildError({
        code: "synthetic_commit_not_on_main",
        message: "The commit is no longer on main.",
        retryable: false,
      }),
    ).toEqual({
      code: "synthetic_commit_not_on_main",
      message: "The commit is no longer on main.",
      retryable: false,
    });
  });

  it("normalizes unknown errors", () => {
    expect(
      normalizeSyntheticBuildError(new Error("Network unavailable")),
    ).toEqual({
      code: "synthetic_build_failed",
      message: "Network unavailable",
      retryable: true,
    });
  });
});
