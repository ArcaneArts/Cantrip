import { describe, expect, it } from "vitest";

import { projectRemovalAction } from "./project-removal";

describe("project removal", () => {
  it("unlinks by default and requires another step for local deletion", () => {
    expect(projectRemovalAction(false, true)).toBe("unlink");
    expect(projectRemovalAction(true, true)).toBe("confirm-delete");
    expect(projectRemovalAction(true, false)).toBe("delete");
  });
});
