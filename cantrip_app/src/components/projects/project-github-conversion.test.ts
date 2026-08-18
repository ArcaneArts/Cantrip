import type { ProjectGithubConversionPreflightReady } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { githubConversionCanStart } from "./project-github-conversion";

const ready = {
  status: "ready",
  projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
  repository: {
    repositoryId: "42",
    nameWithOwner: "ArcaneArts/Scratch",
    url: "https://github.com/ArcaneArts/Scratch",
  },
  confirmationToken: "a".repeat(64),
  localState: "not-initialized",
  branch: null,
  head: null,
  dirty: false,
  originUrl: null,
  requiresInitialCommit: true,
  warnings: [],
} satisfies ProjectGithubConversionPreflightReady;

describe("githubConversionCanStart", () => {
  it("requires separate repository and initial-commit confirmations", () => {
    expect(
      githubConversionCanStart({
        confirmedInitialCommit: false,
        confirmedRepository: true,
        preflight: ready,
      }),
    ).toBe(false);
    expect(
      githubConversionCanStart({
        confirmedInitialCommit: true,
        confirmedRepository: true,
        preflight: ready,
      }),
    ).toBe(true);
  });

  it("does not require a commit confirmation for existing history", () => {
    expect(
      githubConversionCanStart({
        confirmedInitialCommit: false,
        confirmedRepository: true,
        preflight: { ...ready, requiresInitialCommit: false },
      }),
    ).toBe(true);
  });
});
