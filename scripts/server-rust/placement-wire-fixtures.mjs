export function placementWireFixtures(label) {
  const projectId = "fixture-project";
  const surfaceKinds = [
    "chat",
    "terminal",
    "explorer",
    "code",
    "browser",
    "remote-desktop",
    "remote-surface",
  ];
  const targets = [
    { kind: "project", projectId },
    { kind: "worker", projectId, workerId: "fixture-worker" },
    { kind: "replica", projectId, projectReplicaId: "fixture-replica" },
    { kind: "worktree", projectId, worktreeId: "fixture-worktree" },
    ...surfaceKinds.map((surfaceKind) => ({
      kind: "surface",
      projectId,
      surfaceKind,
      surfaceId: "fixture-surface",
    })),
  ];
  const placement = (target) => ({
    projectId,
    workerId: "fixture-worker",
    projectReplicaId: "fixture-replica",
    worktreeId: "fixture-worktree",
    surface:
      target.kind === "surface"
        ? { kind: target.surfaceKind, id: target.surfaceId }
        : null,
  });
  const resolution = (target) => ({
    target,
    placement: placement(target),
    worker: {
      workerId: "fixture-worker",
      name: "Fixture worker",
      online: true,
    },
    availability: "available",
    unavailableReason: null,
  });
  const descriptors = targets.map((target) => {
    const resourceKind =
      target.kind === "surface" ? target.surfaceKind : target.kind;
    const recordKind =
      resourceKind === "code"
        ? "code-tab"
        : resourceKind === "remote-desktop"
          ? "project-view"
          : resourceKind;
    return {
      ...resolution(target),
      resourceKind,
      status: null,
      title: target.kind === "surface" ? null : "Fixture target",
      titleProtection:
        target.kind === "surface"
          ? { ...label, classification: { recordKind } }
          : null,
    };
  });
  return {
    chatWireSummarySchema: [
      {
        id: "chat",
        contextKind: "project",
        projectId,
        activeWorktreeId: "fixture-worktree",
        activeScratchRootId: null,
        activeWorkerId: "fixture-worker",
        titleProtection: { ...label, classification: { recordKind: "chat" } },
        experience: "agent",
        position: 0,
        status: "idle",
        placementRevision: 1,
        worktreeMode: "agent-managed",
        modelId: null,
        reasoningEffort: null,
        customSubagentModel: false,
        subagentModelId: null,
        subagentReasoningEffort: null,
        permissionProfileId: null,
        planMode: "default",
        hasPendingPlanQuestion: false,
        hasUnreadCompletion: false,
        automationPaused: false,
        githubAgentContext: null,
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      },
    ].flatMap((chat) => [
      chat,
      ...[
        { kind: "issue", intent: "start-work" },
        { kind: "pull-request", intent: "address-review" },
        { kind: "pull-request", intent: "fix-checks" },
      ].map((context) => ({
        ...chat,
        githubAgentContext: { ...context, number: 1, headSha: "a".repeat(40) },
      })),
    ]),
    executionPlacementResolveRequestSchema: surfaceKinds.flatMap(
      (surfaceKind) => [
        { surfaceKind },
        ...targets.map((target) => ({ surfaceKind, target })),
      ],
    ),
    executionPlacementResolutionSchema: [
      "explicit",
      "project-preference",
      "default-worker",
      "fallback",
    ].flatMap((selection) =>
      targets.map((target) => ({ placement: placement(target), selection })),
    ),
    executionTargetResolveRequestSchema: targets.flatMap((target) => [
      { target },
      { target, allowUnavailable: false },
      { target, allowUnavailable: true },
    ]),
    executionTargetResolutionSchema: targets.flatMap((target) => [
      resolution(target),
      {
        ...resolution(target),
        availability: "worker-offline",
        worker: {
          workerId: "fixture-worker",
          name: "Fixture worker",
          online: false,
        },
        unavailableReason: "Worker is offline.",
      },
    ]),
    executionTargetWireCatalogSchema: [
      { projectId, targets: [], truncated: false },
      ...descriptors.map((descriptor) => ({
        projectId,
        targets: [descriptor],
        truncated: false,
      })),
      { projectId, targets: descriptors, truncated: true },
    ],
  };
}
