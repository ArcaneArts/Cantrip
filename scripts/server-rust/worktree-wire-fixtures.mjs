export function worktreeWireFixtures() {
  const id = "11111111-1111-4111-8111-111111111111",
    projectId = "22222222-2222-4222-8222-222222222222";
  const at = "2026-10-25T00:00:00.000Z",
    handle = "ctrr_" + Buffer.alloc(32, 1).toString("base64url");
  const worker = {
    path: handle,
    head: "a".repeat(40),
    branch: "main",
    detached: false,
    isPrimary: true,
    managed: false,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    missing: false,
  };
  const inventory = {
    sourcePath: handle,
    primaryPath: handle,
    gitCommonDir: handle,
    managedRoot: handle,
    repositoryFingerprint: "a".repeat(64),
    worktrees: [worker],
  };
  const worktree = {
    id,
    projectSourceId: "source",
    projectId,
    rootKind: "git-worktree",
    workerId: "worker",
    name: "Primary",
    path: handle,
    displayPath: handle,
    isPrimary: true,
    isDefault: true,
    origin: "external",
    lifecycleState: "ready",
    branch: "main",
    head: "a".repeat(40),
    detached: false,
    locked: false,
    lockReason: null,
    lastScannedAt: at,
    createdAt: at,
    updatedAt: at,
  };
  const pullRequest = {
    number: 1,
    title: "Fixture change",
    state: "open",
    url: "https://github.com/example/repository/pull/1",
    author: "fixture",
    commentCount: 0,
    labels: [{ name: "test", color: "aabbcc" }],
    assignees: ["fixture"],
    milestone: null,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    body: null,
    draft: false,
    merged: false,
    headRef: "feature",
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
    mergeable: null,
    reviewDecision: "none",
    checksState: "unknown",
  };
  return {
    worktreeObservationConfigurationResultSchema: [
      {
        accepted: true,
        paths: [
          {
            projectId,
            worktreeId: id,
            sourcePath: handle,
            worktreePath: handle,
          },
        ],
      },
    ],
    worktreeInventorySchema: [inventory],
    projectWorktreeCreateSchema: [
      {
        name: "Feature",
        mode: { type: "newBranch", branch: "feature", startPoint: "HEAD" },
        sourceWorktreeId: id,
      },
      { name: "Detached", mode: { type: "detached", revision: "HEAD" } },
    ],
    projectWorktreeListSchema: [[worktree]],
    projectWorktreeSummarySchema: [worktree],
    projectWorktreeLockSchema: [{ reason: "Review" }, {}],
    projectWorktreePruneSchema: [{ allowExternal: true }],
    projectWorktreeRemoveSchema: [{ force: true, allowExternal: true }],
    worktreeMutationResultSchema: [{ worktree: worker, inventory }],
    worktreePruneResultSchema: [{ prunedPaths: [handle], inventory }],
    worktreeCreateResultSchema: [
      { created: true, worktree: worker, inventory },
    ],
    worktreeRemoveResultSchema: [{ removedPath: handle, inventory }],
    worktreeCreateMutationFailureSchema: [
      {
        code: "worktree-create-not-started",
        error: "Fixture failure",
        mutation: { outcome: "notStarted", retryable: true, target: null },
      },
      {
        code: "worktree-create-partial",
        error: "Fixture partial failure",
        mutation: {
          outcome: "partial",
          retryable: false,
          target: { kind: "worktree", projectId, worktreeId: id },
        },
      },
    ],
    githubPullRequestCheckoutPreparedSchema: [
      {
        pullRequest,
        branch: "feature",
        name: "Feature",
        headSha: "a".repeat(40),
        remote: "origin",
      },
    ],
    githubPullRequestCheckoutResultSchema: [
      { pullRequest, worktree, reused: false },
    ],
    codeGraphProjectStatusSchema: [
      {
        projectId,
        worktreeId: id,
        state: "ready",
        lastIndexedAt: at,
        lastSuccessfulSyncAt: at,
        fileCount: 1,
        nodeCount: 2,
        edgeCount: 3,
        pendingChanges: 0,
        statusMessage: null,
        job: {
          id,
          action: "sync",
          state: "completed",
          requestedAt: at,
          completedAt: at,
        },
      },
    ],
  };
}
