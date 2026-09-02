import { isLocalGitProject, isWorkerBoundFolderProject } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("project storage affinity", () => {
  it("distinguishes plain folders, local Git checkouts, and GitHub projects", () => {
    expect(isWorkerBoundFolderProject("managed-folder", false)).toBe(true);
    expect(isLocalGitProject("managed-folder", false)).toBe(false);

    expect(isWorkerBoundFolderProject("managed-folder", true)).toBe(false);
    expect(isLocalGitProject("managed-folder", true)).toBe(true);

    expect(isWorkerBoundFolderProject("github", true)).toBe(false);
    expect(isLocalGitProject("github", true)).toBe(false);
  });
});
