import { describe, expect, it } from "vitest";

import { hasScrolledContent } from "./scroll-divider";

describe("scroll-aware divider visibility", () => {
  it("appears only after content moves away from its top boundary", () => {
    expect(hasScrolledContent({ scrollTop: 0 })).toBe(false);
    expect(hasScrolledContent({ scrollTop: 1 })).toBe(false);
    expect(hasScrolledContent({ scrollTop: 1.5 })).toBe(true);
    expect(hasScrolledContent({ scrollTop: 24 })).toBe(true);
  });

  it("ignores non-scroll event targets", () => {
    expect(hasScrolledContent(null)).toBe(false);
    expect(hasScrolledContent({})).toBe(false);
    expect(hasScrolledContent({ scrollTop: "12" })).toBe(false);
  });
});
