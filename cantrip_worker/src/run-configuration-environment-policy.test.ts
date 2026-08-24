import { describe, expect, it } from "vitest";

import { runConfigurationEnvironmentNameIsReserved } from "./run-configuration-environment-policy.js";

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
});
