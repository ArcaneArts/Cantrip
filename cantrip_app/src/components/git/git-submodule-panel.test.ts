import type { GitSubmoduleSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { submoduleStateLabel } from "./git-submodule-panel";

const module: GitSubmoduleSummary = {
  name: "library",
  path: "modules/library",
  url: "https://example.com/library.git",
  branch: "main",
  expectedHash: "1".repeat(40),
  currentHash: "1".repeat(40),
  initialized: true,
  dirty: false,
  nested: false,
  state: "clean",
};

describe("submodule repository controls", () => {
  it("describes clean, changed, and dirty submodule state", () => {
    expect(submoduleStateLabel(module)).toBe("recorded commit");
    expect(submoduleStateLabel({ ...module, state: "changed" })).toBe(
      "different commit",
    );
    expect(submoduleStateLabel({ ...module, dirty: true })).toBe(
      "local changes",
    );
  });
});
