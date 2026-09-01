import { describe, expect, it } from "vitest";

import {
  detectClientRuntimePlatform,
  nativeInstallationStorageRequired,
  type RuntimePlatformProbe,
} from "./runtime-platform";

function probe(
  overrides: Partial<RuntimePlatformProbe> = {},
): RuntimePlatformProbe {
  return {
    capacitorNative: false,
    capacitorPlatform: "web",
    tauri: false,
    ...overrides,
  };
}

describe("client runtime platform", () => {
  it("selects Tauri before a bundled web compatibility shim", () => {
    const platform = detectClientRuntimePlatform(
      probe({
        capacitorNative: true,
        capacitorPlatform: "ios",
        tauri: true,
      }),
    );

    expect(platform).toBe("tauri");
    expect(nativeInstallationStorageRequired(platform)).toBe(true);
  });

  it.each([
    ["ios", "capacitor-ios"],
    ["android", "capacitor-android"],
  ] as const)("selects the Capacitor %s provider", (native, expected) => {
    const platform = detectClientRuntimePlatform(
      probe({ capacitorNative: true, capacitorPlatform: native }),
    );

    expect(platform).toBe(expected);
    expect(nativeInstallationStorageRequired(platform)).toBe(true);
  });

  it("keeps ordinary browsers on browser storage", () => {
    const platform = detectClientRuntimePlatform(probe());

    expect(platform).toBe("browser");
    expect(nativeInstallationStorageRequired(platform)).toBe(false);
  });

  it("fails closed for an unknown native platform", () => {
    const platform = detectClientRuntimePlatform(
      probe({ capacitorNative: true, capacitorPlatform: "visionos" }),
    );

    expect(platform).toBe("unsupported-native");
    expect(nativeInstallationStorageRequired(platform)).toBe(true);
  });
});
