import { describe, expect, it } from "vitest";

import {
  requireReviewedOperationContext,
  reviewedOperationAvailability,
} from "./reviewed-operation";

describe("reviewed operation state", () => {
  it("opens as soon as a request enters review", () => {
    expect(reviewedOperationAvailability(true, false, false, false).open).toBe(
      true,
    );
  });

  it("does not allow apply until the matching preview exists", () => {
    expect(
      reviewedOperationAvailability(true, false, false, false).canApply,
    ).toBe(false);
    expect(
      reviewedOperationAvailability(true, true, true, false).canApply,
    ).toBe(true);
  });

  it("invalidates apply when the request changes after preview", () => {
    expect(
      reviewedOperationAvailability(true, true, false, false).canApply,
    ).toBe(false);
  });

  it("blocks duplicate apply while the reviewed operation is pending", () => {
    expect(reviewedOperationAvailability(true, true, true, true).canApply).toBe(
      false,
    );
  });

  it("returns only the request paired with its preview token", () => {
    const request = { action: "delete" };
    const preview = { token: "review-token" };
    expect(
      requireReviewedOperationContext(
        request,
        request,
        preview,
        Object.is,
        "missing",
        "stale",
      ),
    ).toEqual({ preview, request });
  });

  it("rejects missing and stale reviews before apply", () => {
    expect(() =>
      requireReviewedOperationContext(
        null,
        null,
        null,
        Object.is,
        "missing review",
        "stale review",
      ),
    ).toThrow("missing review");
    expect(() =>
      requireReviewedOperationContext(
        { action: "delete" },
        { action: "create" },
        { token: "review-token" },
        (left, right) => left.action === right.action,
        "missing review",
        "stale review",
      ),
    ).toThrow("stale review");
  });
});
