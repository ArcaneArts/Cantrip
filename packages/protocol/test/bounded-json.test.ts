import { describe, expect, it } from "vitest";

import {
  boundedJsonObjectSchema,
  boundedJsonObjectSchemaWithLimits,
  boundedJsonValueSchema,
} from "../src/bounded-json.js";

describe("bounded JSON contracts", () => {
  it("accepts bounded JSON values and objects", () => {
    expect(
      boundedJsonValueSchema.parse({ nested: [true, 42, "safe", null] }),
    ).toEqual({ nested: [true, 42, "safe", null] });
    expect(boundedJsonObjectSchema.parse({ value: "safe" })).toEqual({
      value: "safe",
    });
  });

  it("rejects non-JSON and oversized values", () => {
    expect(boundedJsonValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(boundedJsonValueSchema.safeParse({ value: undefined }).success).toBe(
      false,
    );
    expect(
      boundedJsonObjectSchemaWithLimits({
        maxBytes: 20,
        maxStringLength: 4,
      }).safeParse({ value: "too long" }).success,
    ).toBe(false);
  });

  it("rejects cycles and shared object references", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundedJsonValueSchema.safeParse(cyclic).success).toBe(false);

    const shared = { value: true };
    expect(
      boundedJsonValueSchema.safeParse({ first: shared, second: shared })
        .success,
    ).toBe(false);
  });
});
