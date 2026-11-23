import { describe, expect, it } from "vitest";

import { parseHttpByteRange } from "../src/http-byte-range.js";

describe("parseHttpByteRange", () => {
  it("accepts bounded, open-ended, and suffix byte ranges", () => {
    expect(parseHttpByteRange(undefined, 100)).toEqual({ kind: "none" });
    expect(parseHttpByteRange("bytes=10-19", 100)).toEqual({
      kind: "range",
      start: 10,
      end: 19,
    });
    expect(parseHttpByteRange("bytes=90-", 100)).toEqual({
      kind: "range",
      start: 90,
      end: 99,
    });
    expect(parseHttpByteRange("bytes=-10", 100)).toEqual({
      kind: "range",
      start: 90,
      end: 99,
    });
    expect(parseHttpByteRange("bytes=-200", 100)).toEqual({
      kind: "range",
      start: 0,
      end: 99,
    });
  });

  it("rejects malformed, multiple, reversed, and unsatisfiable ranges", () => {
    expect(parseHttpByteRange("items=0-1", 100)).toEqual({ kind: "invalid" });
    expect(parseHttpByteRange("bytes=0-1,3-4", 100)).toEqual({
      kind: "invalid",
    });
    expect(parseHttpByteRange("bytes=20-10", 100)).toEqual({
      kind: "invalid",
    });
    expect(parseHttpByteRange("bytes=100-", 100)).toEqual({
      kind: "invalid",
    });
    expect(parseHttpByteRange("bytes=0-", 0)).toEqual({ kind: "invalid" });
  });
});
