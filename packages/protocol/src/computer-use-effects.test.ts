import { describe, expect, it } from "vitest";
import {
  cuaEffectConfigurationSchema,
  effectiveCuaEffects,
} from "./computer-use-effects.js";
import { userSettingsUpdateSchema } from "./settings.js";

describe("window effect preferences", () => {
  it("uses Off for missing settings and overrides a selected effect when computer use is disabled", () => {
    expect(effectiveCuaEffects({}).configuration.effect).toBe("off");
    expect(
      effectiveCuaEffects({
        computerUseEnabled: false,
        computerUseEffectsRevision: 9,
        computerUseEffects: { effect: "debug-gradient", parameters: {} },
      }),
    ).toEqual({
      revision: 9,
      configuration: { effect: "off", parameters: {} },
    });
  });
  it("rejects unknown parameters and out-of-contract values", () => {
    for (const parameters of [
      { strength: 2 },
      { radius: 0 },
      { showTelemetry: 0.5 },
      { velocity: 1 },
      { strength: Infinity },
    ]) {
      expect(
        cuaEffectConfigurationSchema.safeParse({
          effect: "debug-gradient",
          parameters,
        }).success,
      ).toBe(false);
    }
    expect(
      cuaEffectConfigurationSchema.safeParse({
        effect: "off",
        parameters: { strength: 1 },
      }).success,
    ).toBe(false);
  });
  it("keeps revisions server-owned and ordinary settings patches independent", () => {
    expect(
      userSettingsUpdateSchema.parse({
        theme: "dark",
        computerUseEffectsRevision: 99,
      }),
    ).toEqual({ theme: "dark" });
    expect(
      userSettingsUpdateSchema.parse({
        computerUseEffects: {
          effect: "debug-gradient",
          parameters: { showTelemetry: 0 },
        },
      }),
    ).toEqual({
      computerUseEffects: {
        effect: "debug-gradient",
        parameters: { showTelemetry: 0 },
      },
    });
  });
});
