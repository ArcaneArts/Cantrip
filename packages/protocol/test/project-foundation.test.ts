import {
  isLocalGitProject,
  isWorkerBoundFolderProject,
  projectCapabilitiesForSource,
} from "../src/index.js";
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

  it("allows local Git projects to attach sources and select eligible workers", () => {
    expect(
      projectCapabilitiesForSource({
        originKind: "managed-folder",
        git: true,
        github: false,
      }),
    ).toEqual({
      git: true,
      github: false,
      worktrees: false,
      replicas: true,
      relocation: true,
    });
    expect(
      projectCapabilitiesForSource({
        originKind: "managed-folder",
        git: false,
        github: false,
      }),
    ).toEqual({
      git: false,
      github: false,
      worktrees: false,
      replicas: false,
      relocation: false,
    });
  });
});
