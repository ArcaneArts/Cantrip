import type {
  ChatExecutionLaneSummary,
  ChatMessage,
  GithubPullRequestSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import type {
  TaskAdvisoryWarning,
  TaskAssociatedPullRequest,
  TaskGoalSnapshot,
  TaskState,
} from "@cantrip/protocol/tasks";

export interface TaskWorktreeObservation {
  dirty: boolean;
  dirtyFileCount: number;
  worktree: ProjectWorktreeSummary;
}

export interface TaskImplementationStateProjection {
  code: string | null;
  reason: string | null;
  state: Extract<
    TaskState,
    "implementing" | "paused" | "blocked" | "complete" | "failed"
  >;
}

function messageText(message: ChatMessage): string {
  return message.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n\n")
    .trim();
}

export function latestTaskImplementationReason(
  messages: readonly ChatMessage[],
  implementationStartedAt: string | null,
): string | null {
  const startedAt = implementationStartedAt
    ? Date.parse(implementationStartedAt)
    : 0;
  for (const message of [...messages].reverse()) {
    if (Date.parse(message.createdAt) < startedAt) continue;
    if (message.role === "user") continue;
    const text = messageText(message);
    if (text) return text.slice(0, 4_000);
  }
  return null;
}

export function projectTaskImplementationState(input: {
  automationPaused: boolean;
  chatStatus:
    "idle" | "running" | "waiting-for-approval" | "offline" | "failed";
  goal: TaskGoalSnapshot | null;
  latestReason: string | null;
}): TaskImplementationStateProjection | null {
  if (input.chatStatus === "failed") {
    return {
      code: "implementation-runtime-failed",
      reason: input.latestReason ?? "The implementation runtime failed.",
      state: "failed",
    };
  }
  if (input.automationPaused) {
    return { code: null, reason: null, state: "paused" };
  }
  if (!input.goal) return null;
  switch (input.goal.status) {
    case "active":
      return { code: null, reason: null, state: "implementing" };
    case "paused":
      return { code: null, reason: null, state: "paused" };
    case "complete":
      return { code: null, reason: null, state: "complete" };
    case "blocked":
      return {
        code: "goal-blocked",
        reason: input.latestReason ?? "The Goal reported a blocker.",
        state: "blocked",
      };
    case "usageLimited":
      return {
        code: "goal-usage-limited",
        reason:
          input.latestReason ?? "The Goal reached a provider usage limit.",
        state: "blocked",
      };
    case "budgetLimited":
      return {
        code: "goal-budget-limited",
        reason: input.latestReason ?? "The Goal reached its token budget.",
        state: "blocked",
      };
  }
}

export function associateTaskPullRequests(input: {
  activeWorktreeId: string;
  implementationStartedAt: string | null;
  lanes: readonly ChatExecutionLaneSummary[];
  pullRequests: readonly GithubPullRequestSummary[];
  worktrees: readonly TaskWorktreeObservation[];
}): TaskAssociatedPullRequest[] {
  const worktreesById = new Map(
    input.worktrees.map((observation) => [
      observation.worktree.id,
      observation,
    ]),
  );
  const branchWorktrees = new Map<string, TaskWorktreeObservation>();
  const laneWorktreeIds = new Set(input.lanes.map((lane) => lane.worktreeId));
  laneWorktreeIds.add(input.activeWorktreeId);
  for (const worktreeId of laneWorktreeIds) {
    const observation = worktreesById.get(worktreeId);
    if (observation?.worktree.branch) {
      branchWorktrees.set(observation.worktree.branch, observation);
    }
  }
  const implementationStartedAt = input.implementationStartedAt
    ? Date.parse(input.implementationStartedAt)
    : 0;

  return input.pullRequests
    .flatMap((pullRequest): TaskAssociatedPullRequest[] => {
      const observation = branchWorktrees.get(pullRequest.headRef);
      const createdDuringImplementation =
        Date.parse(pullRequest.createdAt) >= implementationStartedAt;
      if (!observation || !createdDuringImplementation) {
        return [];
      }
      const active = observation?.worktree.id === input.activeWorktreeId;
      return [
        {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          state: pullRequest.state,
          draft: pullRequest.draft,
          merged: pullRequest.merged,
          headRef: pullRequest.headRef,
          headSha: pullRequest.headSha,
          baseRef: pullRequest.baseRef,
          baseSha: pullRequest.baseSha,
          createdAt: pullRequest.createdAt,
          updatedAt: pullRequest.updatedAt,
          closedAt: pullRequest.closedAt,
          associationKind: "inferred",
          associationSource: active ? "worktree" : "lane-branch",
          confidence: active ? "high" : "medium",
          worktreeId: observation?.worktree.id ?? null,
          worktreeName: observation?.worktree.name ?? null,
        },
      ];
    })
    .sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
}

export function taskAdvisoryWarnings(input: {
  activeWorktreeId: string;
  lanes: readonly ChatExecutionLaneSummary[];
  pullRequests: readonly TaskAssociatedPullRequest[];
  state: TaskState;
  worktrees: readonly TaskWorktreeObservation[];
}): TaskAdvisoryWarning[] {
  const warnings: TaskAdvisoryWarning[] = [];
  const open = input.pullRequests.filter(
    (pullRequest) => pullRequest.state === "open",
  );
  if (open.length > 1) {
    warnings.push({
      code: "multiple-open-pull-requests",
      message: `${open.length} Task-associated pull requests are open. Finish the intended cycle before starting another when your policies require sequential PRs.`,
      pullRequestNumber: null,
      worktreeId: null,
    });
  }
  const activeLane = input.lanes.find(
    (lane) => lane.worktreeId === input.activeWorktreeId,
  );
  for (const pullRequest of open) {
    if (
      pullRequest.worktreeId &&
      pullRequest.worktreeId !== input.activeWorktreeId &&
      activeLane &&
      input.lanes.some(
        (lane) =>
          lane.worktreeId === pullRequest.worktreeId &&
          Date.parse(lane.createdAt) < Date.parse(activeLane.createdAt),
      )
    ) {
      warnings.push({
        code: "new-worktree-before-merge",
        message: `Work continued in a newer worktree while PR #${pullRequest.number} remains open.`,
        pullRequestNumber: pullRequest.number,
        worktreeId: pullRequest.worktreeId,
      });
    }
  }
  if (input.state !== "complete") {
    for (const pullRequest of input.pullRequests) {
      if (pullRequest.state === "closed" && !pullRequest.merged) {
        warnings.push({
          code: "closed-unmerged",
          message: `PR #${pullRequest.number} closed without merging while this Task continued.`,
          pullRequestNumber: pullRequest.number,
          worktreeId: pullRequest.worktreeId,
        });
      }
    }
  }
  const worktreesById = new Map(
    input.worktrees.map((observation) => [
      observation.worktree.id,
      observation,
    ]),
  );
  for (const pullRequest of input.pullRequests) {
    const observation = pullRequest.worktreeId
      ? worktreesById.get(pullRequest.worktreeId)
      : null;
    if (pullRequest.merged && observation?.dirty) {
      warnings.push({
        code: "dirty-after-merge",
        message: `${observation.worktree.name} still has ${observation.dirtyFileCount} local change${observation.dirtyFileCount === 1 ? "" : "s"} after PR #${pullRequest.number} merged.`,
        pullRequestNumber: pullRequest.number,
        worktreeId: observation.worktree.id,
      });
    }
  }
  if (input.state === "complete") {
    for (const pullRequest of open) {
      warnings.push({
        code: "complete-with-open-pull-request",
        message: `This Task is complete but PR #${pullRequest.number} remains open.`,
        pullRequestNumber: pullRequest.number,
        worktreeId: pullRequest.worktreeId,
      });
    }
  }
  return warnings;
}
