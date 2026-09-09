import { describe, expect, it } from "vitest";
import { nativeSettingsPatchSchema } from "../src/native-settings-update.js";

describe("native service tier selection patch", () => {
  it.each([
    {},
    { unsetServiceTier: false },
    { unsetServiceTier: true },
    { serviceTier: null },
    { serviceTier: "default" },
    { serviceTier: "priority" },
    { serviceTier: null, unsetServiceTier: false },
  ])("preserves exact wire intent %j", (patch) => {
    expect(nativeSettingsPatchSchema.parse(patch)).toEqual(patch);
  });
  it.each([null, "default", "priority"])(
    "rejects simultaneous unset and explicit tier %s",
    (serviceTier) => {
      expect(
        nativeSettingsPatchSchema.safeParse({
          unsetServiceTier: true,
          serviceTier,
        }).success,
      ).toBe(false);
    },
  );
  it("rejects a malformed unset flag", () => {
    expect(
      nativeSettingsPatchSchema.safeParse({ unsetServiceTier: "true" }).success,
    ).toBe(false);
  });
});
