import { describe, expect, it } from "vitest";

import { githubRepositoryOnboardingAction } from "./github-repository-onboarding";

describe("GitHub repository onboarding", () => {
  it("waits for setup before creating the initial chat", () => {
    expect(githubRepositoryOnboardingAction("project-1", undefined)).toBe(
      "wait",
    );
    expect(
      githubRepositoryOnboardingAction("project-1", [
        { id: "project-1", setupStatus: "cloning" },
      ]),
    ).toBe("wait");
    expect(
      githubRepositoryOnboardingAction("project-1", [
        { id: "project-1", setupStatus: "ready" },
      ]),
    ).toBe("create-chat");
    expect(
      githubRepositoryOnboardingAction("project-1", [
        { id: "project-1", setupStatus: "failed" },
      ]),
    ).toBe("stop");
  });
});
