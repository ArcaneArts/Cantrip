import type { ExecutionTarget } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { terminalCreatePlacement } from "./api";

describe("terminal creation placement", () => {
  it("prefers an explicit execution target over the legacy worktree field", () => {
    const target: ExecutionTarget = {
      kind: "worktree",
      projectId: "project-one",
      worktreeId: "worktree-one",
    };

    expect(terminalCreatePlacement("worktree-one", target)).toEqual({ target });
    expect(terminalCreatePlacement("worktree-one", undefined)).toEqual({
      worktreeId: "worktree-one",
    });
  });
});
