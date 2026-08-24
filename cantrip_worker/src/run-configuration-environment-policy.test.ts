import { describe, expect, it } from "vitest";

import {
  mergeRunConfigurationEnvironmentLayers,
  runConfigurationEnvironmentNameIsReserved,
  runConfigurationEnvironmentValue,
} from "./run-configuration-environment-policy.js";

describe("Run configuration environment policy", () => {
  it.each([
    "CANTRIP_WORKER_CREDENTIAL",
    "cantrip_project_root",
    "_Cantrip_Run_Env_Capture",
    "CODEX_WORKTREE_PATH",
    "codex_worktree_path",
  ])("reserves %s without platform-dependent casing", (name) => {
    expect(runConfigurationEnvironmentNameIsReserved(name)).toBe(true);
  });

  it.each(["PATH", "JAVA_HOME", "CODEX_VALUE", "PROJECT_CANTRIP_MODE"])(
    "allows ordinary project variable %s",
    (name) => {
      expect(runConfigurationEnvironmentNameIsReserved(name)).toBe(false);
    },
  );

  it("applies later Windows layers to case-insensitive names", () => {
    const environment = mergeRunConfigurationEnvironmentLayers(
      "win32",
      { Path: "baseline", SHARED: "baseline", BASELINE_ONLY: "yes" },
      { PATH: "codex", shared: "codex" },
      { path: "file" },
      { PaTh: "plain" },
    );

    expect(environment).toEqual({
      BASELINE_ONLY: "yes",
      shared: "codex",
      PaTh: "plain",
    });
    expect(
      Object.keys(environment).filter((name) => name.toUpperCase() === "PATH"),
    ).toHaveLength(1);
    expect(runConfigurationEnvironmentValue(environment, "PATH", "win32")).toBe(
      "plain",
    );
  });

  it("preserves case-distinct POSIX environment names", () => {
    const environment = mergeRunConfigurationEnvironmentLayers(
      "linux",
      { Path: "mixed" },
      { PATH: "upper" },
    );

    expect(environment).toEqual({ Path: "mixed", PATH: "upper" });
    expect(runConfigurationEnvironmentValue(environment, "path", "linux")).toBe(
      undefined,
    );
  });

  it("preserves identifier-safe names without mutating the result prototype", () => {
    const environment = mergeRunConfigurationEnvironmentLayers(
      "linux",
      Object.fromEntries([["__proto__", "literal-value"]]),
    );

    expect(Object.getPrototypeOf(environment)).toBe(Object.prototype);
    expect(Object.hasOwn(environment, "__proto__")).toBe(true);
    expect(environment["__proto__"]).toBe("literal-value");
  });
});
