import { projectCapabilitiesForOriginKind } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { projectHasGithubCapability } from "./project-capabilities";

describe("project capabilities", () => {
  it("keeps GitHub features available when display metadata is unavailable", () => {
    expect(
      projectHasGithubCapability({
        capabilities: projectCapabilitiesForOriginKind("github"),
        github: null,
      }),
    ).toBe(true);
  });

  it("does not infer GitHub support from display metadata", () => {
    expect(
      projectHasGithubCapability({
        capabilities: projectCapabilitiesForOriginKind("managed-folder"),
        github: {
          repositoryId: "repository-1",
          nameWithOwner: "cantrip/example",
          url: "https://github.com/cantrip/example",
        },
      }),
    ).toBe(false);
  });
});
