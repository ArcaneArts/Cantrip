import type {
  ChatExecutionLaneSummary,
  GithubPullRequestSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  associateTaskPullRequests,
  projectTaskImplementationState,
  taskAdvisoryWarnings,
  type TaskWorktreeObservation,
} from "../src/tasks/dashboard.js";

const now = "2026-08-17T12:00:00.000Z";
const activeWorktree: ProjectWorktreeSummary = {
  id: "worktree-new",
  projectSourceId: "source",
  projectId: "project",
  workerId: "worker",
  name: "Cycle 2",
  path: "/repo/cycle-2",
  displayPath: "repo/cycle-2",
  isPrimary: false,
  isDefault: false,
  origin: "agent",
  lifecycleState: "ready",
  branch: "agent/manual/cycle-2",
  head: "2".repeat(40),
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: now,
  createdAt: now,
  updatedAt: now,
};
const earlierWorktree: ProjectWorktreeSummary = {
  ...activeWorktree,
  id: "worktree-old",
  name: "Cycle 1",
  path: "/repo/cycle-1",
  displayPath: "repo/cycle-1",
  branch: "agent/manual/cycle-1",
  head: "1".repeat(40),
};
const observations: TaskWorktreeObservation[] = [
  { dirty: false, dirtyFileCount: 0, worktree: activeWorktree },
  { dirty: true, dirtyFileCount: 2, worktree: earlierWorktree },
];
const lanes: ChatExecutionLaneSummary[] = [
  {
    id: "lane-new",
    chatId: "chat",
    worktreeId: activeWorktree.id,
    workerId: "worker",
    acquiringActor: "agent",
    exclusive: true,
    purpose: "Cycle 2",
    state: "active",
    baseRevision: null,
    startingHead: activeWorktree.head,
    runtimeSessionId: null,
    codexThreadId: "thread",
    transitionKind: null,
    createdAt: "2026-08-17T12:05:00.000Z",
    activatedAt: "2026-08-17T12:05:00.000Z",
    releasedAt: null,
    updatedAt: "2026-08-17T12:05:00.000Z",
  },
  {
    id: "lane-old",
    chatId: "chat",
    worktreeId: earlierWorktree.id,
    workerId: "worker",
    acquiringActor: "agent",
    exclusive: true,
    purpose: "Cycle 1",
    state: "released",
    baseRevision: null,
    startingHead: earlierWorktree.head,
    runtimeSessionId: null,
    codexThreadId: "thread",
    transitionKind: null,
    createdAt: "2026-08-17T12:01:00.000Z",
    activatedAt: "2026-08-17T12:01:00.000Z",
    releasedAt: "2026-08-17T12:04:00.000Z",
    updatedAt: "2026-08-17T12:04:00.000Z",
  },
];

function pullRequest(
  number: number,
  headRef: string,
  state: "open" | "closed" = "open",
  merged = false,
): GithubPullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    state,
    url: `https://github.com/ArcaneArts/Cantrip/pull/${number}`,
    author: "agent",
    commentCount: 0,
    labels: [],
    createdAt: "2026-08-17T12:02:00.000Z",
    updatedAt: "2026-08-17T12:03:00.000Z",
    closedAt: state === "closed" ? "2026-08-17T12:04:00.000Z" : null,
    body: null,
    draft: false,
    merged,
    headRef,
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
  };
}

describe("Task implementation dashboard", () => {
  it("maps Goal, pause, limits, completion, and runtime failure to Task states", () => {
    const goal = {
      threadId: "thread",
      objective: "Implement",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 3,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(
      projectTaskImplementationState({
        automationPaused: false,
        chatStatus: "running",
        goal,
        latestReason: null,
      }),
    ).toMatchObject({ state: "implementing" });
    expect(
      projectTaskImplementationState({
        automationPaused: true,
        chatStatus: "idle",
        goal,
        latestReason: null,
      }),
    ).toMatchObject({ state: "paused" });
    expect(
      projectTaskImplementationState({
        automationPaused: false,
        chatStatus: "idle",
        goal: { ...goal, status: "usageLimited" },
        latestReason: "Provider quota exhausted until tomorrow.",
      }),
    ).toMatchObject({
      state: "blocked",
      code: "goal-usage-limited",
      reason: "Provider quota exhausted until tomorrow.",
    });
    expect(
      projectTaskImplementationState({
        automationPaused: false,
        chatStatus: "failed",
        goal,
        latestReason: "Runtime disconnected.",
      }),
    ).toMatchObject({ state: "failed", reason: "Runtime disconnected." });
    expect(
      projectTaskImplementationState({
        automationPaused: false,
        chatStatus: "idle",
        goal: { ...goal, status: "complete" },
        latestReason: null,
      }),
    ).toMatchObject({ state: "complete" });
  });

  it("associates Task branches without scanning encrypted messages", () => {
    const associated = associateTaskPullRequests({
      activeWorktreeId: activeWorktree.id,
      implementationStartedAt: "2026-08-17T12:00:00.000Z",
      lanes,
      pullRequests: [
        pullRequest(10, activeWorktree.branch!),
        pullRequest(11, earlierWorktree.branch!),
        pullRequest(12, "external-branch"),
        pullRequest(13, "unrelated"),
      ],
      worktrees: observations,
    });
    expect(associated.map(({ number }) => number).sort()).toEqual([10, 11]);
    expect(associated.find(({ number }) => number === 10)).toMatchObject({
      associationKind: "inferred",
      associationSource: "worktree",
      confidence: "high",
    });
    expect(associated.find(({ number }) => number === 11)).toMatchObject({
      associationSource: "lane-branch",
      confidence: "medium",
    });
    expect(associated.find(({ number }) => number === 12)).toBeUndefined();
  });

  it("reports protocol deviations as nonblocking advisories", () => {
    const associated = associateTaskPullRequests({
      activeWorktreeId: activeWorktree.id,
      implementationStartedAt: "2026-08-17T12:00:00.000Z",
      lanes,
      messages: [],
      pullRequests: [
        pullRequest(10, activeWorktree.branch!),
        pullRequest(11, earlierWorktree.branch!),
        pullRequest(12, earlierWorktree.branch!, "closed", true),
        pullRequest(13, activeWorktree.branch!, "closed", false),
      ],
      repository: "ArcaneArts/Cantrip",
      worktrees: observations,
    });
    const codes = taskAdvisoryWarnings({
      activeWorktreeId: activeWorktree.id,
      lanes,
      pullRequests: associated,
      state: "implementing",
      worktrees: observations,
    }).map(({ code }) => code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "multiple-open-pull-requests",
        "new-worktree-before-merge",
        "closed-unmerged",
        "dirty-after-merge",
      ]),
    );
  });
});
