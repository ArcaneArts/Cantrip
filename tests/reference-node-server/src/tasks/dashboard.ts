import type {
  ChatExecutionLaneSummary,
  GithubPullRequestSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import type {
  TaskAdvisoryWarning,
  TaskAssociatedPullRequest,
  TaskState,
} from "@cantrip/protocol/tasks";

export interface TaskWorktreeObservation {
  dirty: boolean;
  dirtyFileCount: number;
  worktree: ProjectWorktreeSummary;
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
