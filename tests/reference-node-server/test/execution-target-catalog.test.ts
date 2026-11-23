import {
  workerSummarySchema,
  type ExecutionTargetWireDescriptor,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  buildExecutionTargetCatalog,
  executionTargetAvailability,
  selectExecutionTarget,
  type FocusedExecutionTargetResourceKind,
} from "../src/execution-targets/catalog.js";

function worker(workerId: string) {
  return workerSummarySchema.parse({
    workerId,
    name: workerId,
    platform: "linux",
    architecture: "x64",
    codexVersion: "0.146.1",
    online: true,
    lastSeenAt: "2026-08-12T12:00:00.000Z",
    startedAt: "2026-08-12T12:00:00.000Z",
  });
}

function descriptor(input: {
  availability?: ExecutionTargetWireDescriptor["availability"];
  id: string;
  resourceKind: FocusedExecutionTargetResourceKind;
  title?: string | null;
  workerId?: string;
  worktreeId?: string | null;
}): ExecutionTargetWireDescriptor {
  const workerId = input.workerId ?? "worker-one";
  const worktreeId = input.worktreeId ?? null;
  const target =
    input.resourceKind === "worker"
      ? {
          kind: "worker" as const,
          projectId: "project-one",
          workerId: input.id,
        }
      : input.resourceKind === "worktree"
        ? {
            kind: "worktree" as const,
            projectId: "project-one",
            worktreeId: input.id,
          }
        : {
            kind: "surface" as const,
            projectId: "project-one",
            surfaceKind: input.resourceKind,
            surfaceId: input.id,
          };
  return {
    availability: input.availability ?? "available",
    placement: {
      projectId: "project-one",
      workerId,
      projectReplicaId: worktreeId ? "replica-one" : null,
      worktreeId,
      surface:
        target.kind === "surface"
          ? { kind: target.surfaceKind, id: target.surfaceId }
          : null,
    },
    resourceKind: input.resourceKind,
    status: null,
    target,
    title: input.title ?? null,
    titleProtection: null,
    unavailableReason:
      input.availability && input.availability !== "available"
        ? "Unavailable for test."
        : null,
    worker: {
      workerId,
      name: workerId,
      online: input.availability !== "worker-offline",
    },
  };
}

describe("execution target catalog", () => {
  it("bounds the returned catalog and reports truncation", () => {
    const catalog = buildExecutionTargetCatalog({
      browsers: [],
      chats: [],
      codeTabs: [],
      desktops: [],
      explorers: [],
      projectId: "project-one",
      remoteSurfaces: [],
      replicas: [],
      terminals: [],
      workers: Array.from({ length: 2_001 }, (_, index) =>
        worker(`worker-${index.toString().padStart(4, "0")}`),
      ),
      worktrees: [],
    });
    expect(catalog.targets).toHaveLength(2_000);
    expect(catalog.truncated).toBe(true);
    expect(catalog.targets[0]).toMatchObject({
      resourceKind: "worker",
      availability: "available",
    });
  });

  it("combines heartbeat, connection, and capability availability", () => {
    const target = worker("worker-one");
    expect(
      executionTargetAvailability(target, null, () => false),
    ).toMatchObject({
      availability: "worker-offline",
      online: false,
    });
    expect(
      executionTargetAvailability(target, "browser", () => true),
    ).toMatchObject({
      availability: "capability-unavailable",
      online: true,
    });
  });

  it("preserves exact-title ambiguity and exact-before-partial precedence", () => {
    const candidates = [
      descriptor({
        id: "worker-alpha",
        resourceKind: "worker",
        title: "Alpha",
      }),
      descriptor({
        id: "worker-beta",
        resourceKind: "worker",
        title: "worker-alpha",
      }),
      descriptor({
        id: "worker-gamma",
        resourceKind: "worker",
        title: "Alpha project replica",
      }),
    ];
    expect(
      selectExecutionTarget(candidates, {
        currentTerminalId: null,
        currentWorkerId: "worker-one",
        currentWorktreeId: "worktree-one",
        resourceKind: null,
        selector: "worker-alpha",
      }),
    ).toMatchObject({
      outcome: "ambiguous",
      matches: [
        { id: "worker-alpha", title: "Alpha" },
        { id: "worker-beta", title: "worker-alpha" },
      ],
    });
    expect(
      selectExecutionTarget(candidates, {
        currentTerminalId: null,
        currentWorkerId: "worker-one",
        currentWorktreeId: "worktree-one",
        resourceKind: "worker",
        selector: "Alpha",
      }),
    ).toEqual({
      outcome: "selected",
      target: candidates[0]!.target,
    });
  });

  it("keeps ID prefix matching case-sensitive and reports ambiguity", () => {
    const candidates = [
      descriptor({ id: "tree-alpha", resourceKind: "worktree" }),
      descriptor({ id: "tree-beta", resourceKind: "worktree" }),
    ];
    const input = {
      currentTerminalId: null,
      currentWorkerId: "worker-one",
      currentWorktreeId: "worktree-one",
      resourceKind: "worktree" as const,
    };
    expect(
      selectExecutionTarget(candidates, { ...input, selector: "tree-b" }),
    ).toEqual({ outcome: "selected", target: candidates[1]!.target });
    expect(
      selectExecutionTarget(candidates, { ...input, selector: "tree-" }),
    ).toMatchObject({ outcome: "ambiguous" });
    expect(
      selectExecutionTarget(candidates, { ...input, selector: "TREE-BETA" }),
    ).toEqual({ outcome: "not-found" });
  });

  it("preserves contextual defaults and availability ordering", () => {
    const currentTerminal = descriptor({
      availability: "worker-offline",
      id: "terminal-current",
      resourceKind: "terminal",
      workerId: "worker-one",
      worktreeId: "worktree-one",
    });
    const remoteTerminal = descriptor({
      id: "terminal-remote",
      resourceKind: "terminal",
      workerId: "worker-two",
      worktreeId: "worktree-two",
    });
    expect(
      selectExecutionTarget([currentTerminal, remoteTerminal], {
        currentTerminalId: "terminal-current",
        currentWorkerId: "worker-one",
        currentWorktreeId: "worktree-one",
        resourceKind: "terminal",
        selector: null,
      }),
    ).toEqual({ outcome: "selected", target: currentTerminal.target });

    const currentWorktree = descriptor({
      availability: "resource-unavailable",
      id: "worktree-one",
      resourceKind: "worktree",
      workerId: "worker-one",
      worktreeId: "worktree-one",
    });
    expect(
      selectExecutionTarget([currentWorktree], {
        currentTerminalId: null,
        currentWorkerId: "worker-one",
        currentWorktreeId: "worktree-one",
        resourceKind: "worktree",
        selector: null,
      }),
    ).toEqual({ outcome: "selected", target: currentWorktree.target });

    const local = descriptor({
      id: "terminal-local",
      resourceKind: "terminal",
      workerId: "worker-one",
      worktreeId: "worktree-one",
    });
    expect(
      selectExecutionTarget([local, remoteTerminal], {
        currentTerminalId: null,
        currentWorkerId: "worker-one",
        currentWorktreeId: "worktree-one",
        resourceKind: "terminal",
        selector: null,
      }),
    ).toEqual({ outcome: "selected", target: local.target });
    expect(
      selectExecutionTarget(
        [
          local,
          descriptor({
            id: "terminal-local-two",
            resourceKind: "terminal",
            workerId: "worker-one",
            worktreeId: "worktree-one",
          }),
          remoteTerminal,
        ],
        {
          currentTerminalId: null,
          currentWorkerId: "worker-one",
          currentWorktreeId: "worktree-one",
          resourceKind: "terminal",
          selector: null,
        },
      ),
    ).toMatchObject({ outcome: "ambiguous", matches: expect.any(Array) });
    expect(
      selectExecutionTarget([currentTerminal], {
        currentTerminalId: null,
        currentWorkerId: "worker-one",
        currentWorktreeId: "worktree-one",
        resourceKind: "terminal",
        selector: null,
      }),
    ).toEqual({ outcome: "unavailable" });
  });
});
