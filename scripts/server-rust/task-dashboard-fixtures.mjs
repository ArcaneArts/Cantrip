import { taskWireFixtures, taskTimestamp } from "./task-wire-fixtures.mjs";
import { standaloneChatWireFixtures } from "./standalone-chat-wire-fixtures.mjs";

export function dashboardPullRequest(number = 1, extra = {}) {
  return {
    number,
    title: `Task PR ${number}`,
    state: "open",
    url: `https://github.com/fixture/repository/pull/${number}`,
    author: "fixture",
    commentCount: 0,
    labels: [],
    assignees: [],
    milestone: null,
    createdAt: taskTimestamp,
    updatedAt: taskTimestamp,
    closedAt: null,
    body: null,
    draft: false,
    merged: false,
    headRef: "task-branch",
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
    ...extra,
  };
}
export function taskDashboardWireFixtures(timestamp) {
  const tasks = taskWireFixtures(timestamp);
  const task = {
    ...tasks.taskOpaqueSummarySchema[0],
    state: "implementing",
    implementationStartedAt: timestamp,
  };
  const placement = {
    kind: "git",
    workerId: "worker",
    worktreeId: "worktree",
    worktreeName: "Task branch",
    branch: "task-branch",
    isPrimary: false,
    dirty: true,
    dirtyFileCount: 1,
  };
  const common = {
    task,
    goal: null,
    goalUnavailableReason: null,
    placement,
    pullRequests: [],
    pullRequestsUnavailableReason: null,
    warnings: [],
  };
  const objective =
    standaloneChatWireFixtures(timestamp).chatMessageOpaqueContentSchema[0];
  objective.classification.mode = "goal";
  const goal = { ...tasks.chatGoalResponseSchema[1].goal };
  delete goal.ignored;
  const protectedGoal = { ...goal, protectedObjective: objective };
  delete protectedGoal.objective;
  return {
    chatGoalCreateSchema: [
      { objective: "A goal" },
      { objective: " Trimmed goal ", tokenBudget: 1000, ignored: true },
    ],
    chatGoalUpdateSchema: [
      { status: "active" },
      { status: "paused", protectedObjective: objective },
      { protectedObjective: objective },
    ],
    chatGoalClearSchema: [{ cleared: true }, { cleared: false, ignored: true }],
    chatGoalWireResponseSchema: [
      { goal: null },
      { goal },
      { kind: "chat-encrypted", goal: protectedGoal },
      {
        kind: "task-encrypted",
        goal: tasks.taskGoalWorkerResultSchema[1].goal,
      },
    ],
    taskImplementationOpaqueDashboardSchema: [
      common,
      {
        ...common,
        placement: {
          kind: "folder",
          workerId: "worker",
          rootId: "root",
          displayPath: "/fixture",
        },
      },
    ],
    githubIssueListFiltersSchema: [
      {},
      { search: " task ", labels: [" feature "], draft: true },
    ],
    githubPullRequestListSchema: [
      { state: "open", total: 0, pullRequests: [], nextCursor: null },
      {
        state: "closed",
        total: 1,
        pullRequests: [
          dashboardPullRequest(1, {
            state: "closed",
            merged: true,
            closedAt: timestamp,
          }),
        ],
        nextCursor: null,
      },
    ],
  };
}

export function* taskDashboardCases() {
  const timestamp = (seconds) =>
    new Date(Date.parse(taskTimestamp) + seconds * 1000).toISOString();
  for (const state of ["implementing", "complete", "failed"])
    for (const dirty of [0, 1, 2])
      for (const ordering of [false, true])
        for (const activeWorktreeId of ["old", "active", "missing"])
          for (const started of [
            null,
            timestamp(-1),
            timestamp(0),
            timestamp(1),
          ]) {
            const worktrees = [
              {
                worktree: {
                  id: "old",
                  branch: "old-branch",
                  name: "Old \ud800 😀",
                },
                dirty: dirty > 0,
                dirtyFileCount: dirty,
              },
              {
                worktree: {
                  id: "active",
                  branch: "task-branch",
                  name: "Active",
                },
                dirty: dirty > 0,
                dirtyFileCount: dirty,
              },
            ];
            const lanes = [
              { worktreeId: "active", createdAt: timestamp(1) },
              { worktreeId: "old", createdAt: timestamp(-1) },
            ];
            const requests = [
              dashboardPullRequest(1),
              dashboardPullRequest(2, { headRef: "old-branch" }),
              dashboardPullRequest(3, {
                state: "closed",
                merged: false,
                headRef: "old-branch",
              }),
              dashboardPullRequest(4, {
                state: "closed",
                merged: true,
                headRef: "old-branch",
              }),
              dashboardPullRequest(5, { headRef: "unrelated" }),
              dashboardPullRequest(6, {
                createdAt: timestamp(-2),
                updatedAt: timestamp(5),
              }),
              dashboardPullRequest(7, { updatedAt: timestamp(2), draft: true }),
            ];
            yield {
              activeWorktreeId,
              implementationStartedAt: started,
              state,
              lanes: ordering ? lanes.toReversed() : lanes,
              worktrees,
              pullRequests: ordering ? requests.toReversed() : requests,
            };
          }
  // Duplicate branch/identifier handling preserves the actual JS Map/Set order.
  for (const activeWorktreeId of ["first", "second"])
    for (const reverseLanes of [false, true])
      for (const reverseTrees of [false, true]) {
        const worktrees = [
          {
            worktree: { id: "first", branch: "task-branch", name: "First" },
            dirty: false,
            dirtyFileCount: 0,
          },
          {
            worktree: { id: "second", branch: "task-branch", name: "Second" },
            dirty: true,
            dirtyFileCount: 1,
          },
          {
            worktree: {
              id: "first",
              branch: "task-branch",
              name: "Final first",
            },
            dirty: true,
            dirtyFileCount: 2,
          },
        ];
        const lanes = [
          { worktreeId: "first", createdAt: timestamp(-1) },
          { worktreeId: "first", createdAt: timestamp(1) },
          { worktreeId: "second", createdAt: timestamp(0) },
          { worktreeId: null, createdAt: timestamp(0) },
        ];
        yield {
          activeWorktreeId,
          implementationStartedAt: taskTimestamp,
          state: "complete",
          lanes: reverseLanes ? lanes.toReversed() : lanes,
          worktrees: reverseTrees ? worktrees.toReversed() : worktrees,
          pullRequests: [
            dashboardPullRequest(1),
            dashboardPullRequest(2, { state: "closed", merged: true }),
          ],
        };
      }
}
