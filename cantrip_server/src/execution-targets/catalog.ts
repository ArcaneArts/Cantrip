import type {
  BrowserSummary,
  ChatWireSummary,
  CodeTabSummary,
  ExecutionPlacement,
  ExecutionTarget,
  ExecutionTargetAvailability,
  ExecutionTargetWireCatalog,
  ExecutionTargetWireDescriptor,
  ExecutionTargetResourceKind,
  ExplorerSummary,
  ProjectReplicaSummary,
  ProjectWorktreeSummary,
  RemoteDesktopSummary,
  RemoteSurfaceSummary,
  TerminalSummary,
  WorkerSummary,
  PrivateDisplayLabelOpaque,
} from "@cantrip/protocol";

export type ExecutionTargetCapability = "browser" | "code" | "desktop" | null;

export function executionTargetAvailability(
  worker: WorkerSummary,
  capability: ExecutionTargetCapability,
  isWorkerConnected?: (workerId: string) => boolean,
): {
  availability: ExecutionTargetAvailability;
  online: boolean;
  unavailableReason: string | null;
} {
  const online =
    worker.online &&
    (isWorkerConnected === undefined || isWorkerConnected(worker.workerId));
  if (!online) {
    return {
      availability: "worker-offline",
      online: false,
      unavailableReason: `Worker ${worker.name} is offline.`,
    };
  }
  const capabilityAvailable =
    capability === null ||
    (capability === "code" && worker.code.available) ||
    (capability === "browser" && worker.remoteSurfaces.browser) ||
    (capability === "desktop" && worker.remoteSurfaces.desktop);
  if (!capabilityAvailable) {
    return {
      availability: "capability-unavailable",
      online: true,
      unavailableReason: `Worker ${worker.name} does not support ${capability}.`,
    };
  }
  return {
    availability: "available",
    online: true,
    unavailableReason: null,
  };
}

export function buildExecutionTargetCatalog(input: {
  browsers: readonly BrowserSummary[];
  chats: readonly ChatWireSummary[];
  codeTabs: readonly CodeTabSummary[];
  desktops: readonly RemoteDesktopSummary[];
  explorers: readonly ExplorerSummary[];
  isWorkerConnected?: (workerId: string) => boolean;
  projectId: string;
  remoteSurfaces: readonly RemoteSurfaceSummary[];
  replicas: readonly ProjectReplicaSummary[];
  terminals: readonly TerminalSummary[];
  workers: readonly WorkerSummary[];
  worktrees: readonly ProjectWorktreeSummary[];
}): ExecutionTargetWireCatalog {
  const workersById = new Map(
    input.workers.map((worker) => [worker.workerId, worker]),
  );
  const worktreesById = new Map(
    input.worktrees.map((worktree) => [worktree.id, worktree]),
  );
  const descriptors: ExecutionTargetWireDescriptor[] = [];
  const append = (candidate: {
    capability?: ExecutionTargetCapability;
    placement: ExecutionPlacement;
    resourceUnavailableReason?: string | null;
    resourceKind: ExecutionTargetResourceKind;
    status: string | null;
    target: ExecutionTarget;
    title?: string;
    titleProtection?: PrivateDisplayLabelOpaque;
  }) => {
    const worker = workersById.get(candidate.placement.workerId);
    if (!worker) return;
    let availability = executionTargetAvailability(
      worker,
      candidate.capability ?? null,
      input.isWorkerConnected,
    );
    if (
      availability.availability === "available" &&
      candidate.resourceUnavailableReason
    ) {
      availability = {
        availability: "resource-unavailable",
        online: true,
        unavailableReason: candidate.resourceUnavailableReason,
      };
    }
    descriptors.push({
      target: candidate.target,
      placement: candidate.placement,
      resourceKind: candidate.resourceKind,
      title: candidate.title ?? null,
      titleProtection: candidate.titleProtection ?? null,
      status: candidate.status,
      worker: {
        workerId: worker.workerId,
        name: worker.name,
        online: availability.online,
      },
      availability: availability.availability,
      unavailableReason: availability.unavailableReason,
    });
  };
  const appendWorktreeSurface = (surface: {
    activeWorkerId: string | null;
    id: string;
    resourceKind: Extract<
      ExecutionTargetResourceKind,
      "chat" | "terminal" | "explorer" | "code"
    >;
    status: string | null;
    title?: string;
    titleProtection?: PrivateDisplayLabelOpaque;
    worktreeId: string;
  }) => {
    const worktree = worktreesById.get(surface.worktreeId);
    const workerId = surface.activeWorkerId ?? worktree?.workerId;
    if (!worktree || !workerId || worktree.workerId !== workerId) return;
    append({
      capability: surface.resourceKind === "code" ? "code" : null,
      placement: {
        projectId: input.projectId,
        workerId,
        projectReplicaId: worktree.projectSourceId,
        worktreeId: worktree.id,
        surface: { kind: surface.resourceKind, id: surface.id },
      },
      resourceKind: surface.resourceKind,
      resourceUnavailableReason:
        worktree.lifecycleState === "ready"
          ? null
          : `Worktree ${worktree.name} is ${worktree.lifecycleState}.`,
      status: surface.status,
      target: {
        kind: "surface",
        projectId: input.projectId,
        surfaceKind: surface.resourceKind,
        surfaceId: surface.id,
      },
      ...(surface.title ? { title: surface.title } : {}),
      ...(surface.titleProtection
        ? { titleProtection: surface.titleProtection }
        : {}),
    });
  };

  for (const worker of input.workers) {
    const replica = input.replicas.find(
      ({ workerId }) => workerId === worker.workerId,
    );
    const primary = input.worktrees.find(
      (worktree) =>
        worktree.id === replica?.primaryWorktreeId &&
        worktree.projectSourceId === replica.id &&
        worktree.workerId === worker.workerId &&
        worktree.lifecycleState === "ready",
    );
    append({
      placement: {
        projectId: input.projectId,
        workerId: worker.workerId,
        projectReplicaId: replica?.id ?? null,
        worktreeId: primary?.id ?? null,
        surface: null,
      },
      resourceKind: "worker",
      status:
        worker.online &&
        (input.isWorkerConnected === undefined ||
          input.isWorkerConnected(worker.workerId))
          ? "online"
          : "offline",
      target: {
        kind: "worker",
        projectId: input.projectId,
        workerId: worker.workerId,
      },
      title: worker.name,
    });
  }
  for (const replica of input.replicas) {
    const primary = input.worktrees.find(
      (worktree) =>
        worktree.id === replica.primaryWorktreeId &&
        worktree.projectSourceId === replica.id &&
        worktree.workerId === replica.workerId &&
        worktree.lifecycleState === "ready",
    );
    append({
      placement: {
        projectId: input.projectId,
        workerId: replica.workerId,
        projectReplicaId: replica.id,
        worktreeId: primary?.id ?? null,
        surface: null,
      },
      resourceKind: "replica",
      resourceUnavailableReason:
        replica.ready && primary
          ? null
          : `The project replica on ${replica.workerName} is not ready.`,
      status: replica.ready ? "ready" : "not ready",
      target: {
        kind: "replica",
        projectId: input.projectId,
        projectReplicaId: replica.id,
      },
      title: `${replica.workerName} project replica`,
    });
  }
  for (const worktree of input.worktrees) {
    append({
      placement: {
        projectId: input.projectId,
        workerId: worktree.workerId,
        projectReplicaId: worktree.projectSourceId,
        worktreeId: worktree.id,
        surface: null,
      },
      resourceKind: "worktree",
      resourceUnavailableReason:
        worktree.lifecycleState === "ready"
          ? null
          : `Worktree ${worktree.name} is ${worktree.lifecycleState}.`,
      status: worktree.lifecycleState,
      target: {
        kind: "worktree",
        projectId: input.projectId,
        worktreeId: worktree.id,
      },
      title: worktree.name,
    });
  }
  for (const chat of input.chats) {
    appendWorktreeSurface({
      activeWorkerId: chat.activeWorkerId,
      id: chat.id,
      resourceKind: "chat",
      status: chat.status,
      titleProtection: chat.titleProtection,
      worktreeId: chat.activeWorktreeId,
    });
  }
  for (const terminal of input.terminals) {
    appendWorktreeSurface({
      activeWorkerId: terminal.activeWorkerId,
      id: terminal.id,
      resourceKind: "terminal",
      status: terminal.status,
      title: terminal.title,
      worktreeId: terminal.worktreeId,
    });
  }
  for (const explorer of input.explorers) {
    appendWorktreeSurface({
      activeWorkerId: explorer.activeWorkerId,
      id: explorer.id,
      resourceKind: "explorer",
      status: null,
      title: explorer.title,
      worktreeId: explorer.worktreeId,
    });
  }
  for (const codeTab of input.codeTabs) {
    appendWorktreeSurface({
      activeWorkerId: codeTab.activeWorkerId,
      id: codeTab.id,
      resourceKind: "code",
      status: codeTab.status,
      title: codeTab.title,
      worktreeId: codeTab.worktreeId,
    });
  }
  const representedRemoteSurfaceIds = new Set<string>();
  for (const browser of input.browsers) {
    const remote = input.remoteSurfaces.find(({ id }) => id === browser.id);
    const workerId = browser.workerId ?? remote?.workerId;
    if (!workerId) continue;
    representedRemoteSurfaceIds.add(browser.id);
    append({
      capability: "browser",
      placement: {
        projectId: input.projectId,
        workerId,
        projectReplicaId: null,
        worktreeId: null,
        surface: { kind: "browser", id: browser.id },
      },
      resourceKind: "browser",
      status: remote?.status ?? null,
      target: {
        kind: "surface",
        projectId: input.projectId,
        surfaceKind: "browser",
        surfaceId: browser.id,
      },
      title: browser.title,
    });
  }
  for (const desktop of input.desktops) {
    representedRemoteSurfaceIds.add(desktop.id);
    append({
      capability: "desktop",
      placement: {
        projectId: input.projectId,
        workerId: desktop.workerId,
        projectReplicaId: null,
        worktreeId: null,
        surface: { kind: "remote-desktop", id: desktop.id },
      },
      resourceKind: "remote-desktop",
      status: desktop.status,
      target: {
        kind: "surface",
        projectId: input.projectId,
        surfaceKind: "remote-desktop",
        surfaceId: desktop.id,
      },
      title: desktop.title,
    });
  }
  for (const surface of input.remoteSurfaces) {
    if (representedRemoteSurfaceIds.has(surface.id)) continue;
    append({
      capability: surface.kind === "browser" ? "browser" : "desktop",
      placement: {
        projectId: input.projectId,
        workerId: surface.workerId,
        projectReplicaId: null,
        worktreeId: null,
        surface: { kind: "remote-surface", id: surface.id },
      },
      resourceKind: "remote-surface",
      status: surface.status,
      target: {
        kind: "surface",
        projectId: input.projectId,
        surfaceKind: "remote-surface",
        surfaceId: surface.id,
      },
      title: surface.title,
    });
  }
  descriptors.sort(
    (left, right) =>
      left.resourceKind.localeCompare(right.resourceKind) ||
      JSON.stringify(left.target).localeCompare(JSON.stringify(right.target)),
  );
  return {
    projectId: input.projectId,
    targets: descriptors.slice(0, 2_000),
    truncated: descriptors.length > 2_000,
  };
}
