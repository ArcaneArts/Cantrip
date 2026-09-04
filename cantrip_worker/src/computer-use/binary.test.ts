import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCuaBinary } from "./binary.js";

afterEach(() => vi.unstubAllEnvs());

describe("Cantrip CUA executable selection", () => {
  it("uses the exact packaged worker directory independently of cwd", () => {
    vi.stubEnv("CANTRIP_CUA_BIN", undefined);
    for (const directory of ["src", "dist"]) {
      expect(
        resolveCuaBinary({
          moduleUrl: `file:///Applications/Cantrip%20IDE.app/Contents/Resources/runtime/worker/${directory}/computer-use/binary.js`,
          platform: "darwin",
        }),
      ).toBe(
        "/Applications/Cantrip IDE.app/Contents/Resources/runtime/worker/bin/cantrip-cua",
      );
    }
    expect(
      resolveCuaBinary({
        moduleUrl: "file:///not-installed/worker/dist/computer-use/binary.js",
        platform: "linux",
      }),
    ).toBe("/not-installed/worker/bin/cantrip-cua");
  });

  it("resolves the Windows packaged executable with native drive paths", () => {
    vi.stubEnv("CANTRIP_CUA_BIN", undefined);
    expect(
      resolveCuaBinary({
        moduleUrl:
          "file:///C:/Program%20Files/Cantrip/runtime/worker/dist/computer-use/binary.js",
        platform: "win32",
      }),
    ).toBe("C:\\Program Files\\Cantrip\\runtime\\worker\\bin\\cantrip-cua.exe");
  });

  it("honors explicit and environment overrides literally without fallback", () => {
    vi.stubEnv("CANTRIP_CUA_BIN", "/environment/selected helper");
    expect(resolveCuaBinary()).toBe("/environment/selected helper");
    for (const override of [
      "",
      "relative/helper",
      "/missing/helper",
      " padded ",
    ]) {
      expect(resolveCuaBinary({ override, moduleUrl: "invalid-url" })).toBe(
        override,
      );
    }
  });
});
