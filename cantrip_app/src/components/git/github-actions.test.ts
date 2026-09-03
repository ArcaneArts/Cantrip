import type { GithubActionsJob, GithubActionsRun } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  githubActionsRunAgentPrompt,
  githubActionsRunIsActive,
  githubActionsStatusLabel,
  parseGithubActionsUrl,
} from "./github-actions-model";

const run = {
  id: 42,
  workflowId: 7,
  name: "CI",
  displayTitle: "Fix the build",
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  headBranch: "feature/actions",
  headSha: "a".repeat(40),
  pullRequestNumber: 12,
  runNumber: 18,
  runAttempt: 1,
  actor: "cantrip-test",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T01:00:00.000Z",
  url: "https://github.com/ArcaneArts/Cantrip/actions/runs/42",
} satisfies GithubActionsRun;

describe("GitHub Actions helpers", () => {
  it("recognizes active runs and presents normalized status labels", () => {
    expect(githubActionsRunIsActive(run)).toBe(false);
    expect(
      githubActionsRunIsActive({
        ...run,
        status: "in-progress",
        conclusion: null,
      }),
    ).toBe(true);
    expect(githubActionsStatusLabel(run)).toBe("failure");
    expect(
      githubActionsStatusLabel({ status: "in-progress", conclusion: null }),
    ).toBe("in progress");
  });

  it("turns GitHub Actions check URLs into exact run and job targets", () => {
    expect(
      parseGithubActionsUrl(
        "https://github.com/ArcaneArts/Cantrip/actions/runs/42/job/9",
      ),
    ).toEqual({ runId: 42, jobId: 9 });
    expect(parseGithubActionsUrl(run.url)).toEqual({
      runId: 42,
      jobId: null,
    });
    expect(
      parseGithubActionsUrl(
        "https://example.com/ArcaneArts/Cantrip/actions/runs/42/job/9",
      ),
    ).toBeNull();
  });

  it("builds a bounded agent handoff around the exact failed run", () => {
    const job = {
      id: 9,
      name: "test",
      status: "completed",
      conclusion: "failure",
      url: `${run.url}/job/9`,
      startedAt: run.createdAt,
      completedAt: run.updatedAt,
      runnerName: "build-mac",
      runnerGroupName: "Default",
      steps: [],
      stepsTruncated: false,
    } satisfies GithubActionsJob;
    const prompt = githubActionsRunAgentPrompt(run, [job]);

    expect(prompt).toContain("workflow run #18");
    expect(prompt).toContain(run.headSha);
    expect(prompt).toContain("test: failure");
    expect(prompt).toContain(run.url);
  });
});
