import {
  projectCapabilitiesForOriginKind,
  type ProjectOriginKind,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  ProjectCapabilityUnavailableError,
  projectCapabilityForRoute,
  requireProjectCapability,
} from "./capabilities.js";

function project(originKind: ProjectOriginKind) {
  return {
    id: "project-one",
    originKind,
    capabilities: projectCapabilitiesForOriginKind(originKind),
  };
}

describe("project capability guards", () => {
  it("preserves every GitHub project capability", () => {
    const github = project("github");

    expect(() => requireProjectCapability(github, "git")).not.toThrow();
    expect(() => requireProjectCapability(github, "github")).not.toThrow();
    expect(() => requireProjectCapability(github, "worktrees")).not.toThrow();
    expect(() => requireProjectCapability(github, "replicas")).not.toThrow();
    expect(() => requireProjectCapability(github, "relocation")).not.toThrow();
  });

  it("returns a stable conflict for unsupported folder capabilities", () => {
    const folder = project("managed-folder");

    expect(() => requireProjectCapability(folder, "git")).toThrowError(
      ProjectCapabilityUnavailableError,
    );
    try {
      requireProjectCapability(folder, "replicas");
      throw new Error("Expected the replica capability guard to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectCapabilityUnavailableError);
      expect((error as ProjectCapabilityUnavailableError).statusCode).toBe(409);
      expect((error as ProjectCapabilityUnavailableError).response()).toEqual({
        code: "project-capability-unavailable",
        capability: "replicas",
        error:
          "This managed-folder project does not support the replicas capability.",
      });
    }
  });

  it("classifies project routes through one central capability map", () => {
    expect(
      projectCapabilityForRoute(
        "GET",
        "/api/projects/:projectId/worktrees/:worktreeId/git/diff",
      ),
    ).toBe("git");
    expect(
      projectCapabilityForRoute(
        "GET",
        "/api/projects/:projectId/github/issues",
      ),
    ).toBe("github");
    expect(
      projectCapabilityForRoute("POST", "/api/projects/:projectId/replicas"),
    ).toBe("replicas");
    expect(
      projectCapabilityForRoute(
        "PATCH",
        "/api/projects/:projectId/preferred-worker",
      ),
    ).toBe("relocation");
    expect(
      projectCapabilityForRoute(
        "POST",
        "/api/projects/:projectId/worktrees/reconcile",
      ),
    ).toBe("worktrees");
    expect(
      projectCapabilityForRoute("GET", "/api/projects/:projectId/worktrees"),
    ).toBeNull();
    expect(
      projectCapabilityForRoute("GET", "/api/projects/:projectId/chats"),
    ).toBeNull();
  });
});
