import {
  chatRelocationJobSummarySchema,
  chatSummarySchema,
  projectReplicaSummarySchema,
  projectWorktreeSummarySchema,
  workerSummarySchema,
  type ChatRelocationJobSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProjectSurfacePlacementContext } from "@/components/workspace/project-surface-create-menu";
import type { WorktreeStatusMap } from "@/components/worktrees/worktree-control";

import {
  activeChatRelocationJob,
  ChatRelocationStatus,
  chatRelocationSourceIssue,
  chatRelocationTargetWorkers,
  latestChatRelocationJob,
} from "./chat-relocation-dialog";

const now = "2026-08-12T12:00:00.000Z";
const sourceRevision = "a".repeat(40);
const otherRevision = "b".repeat(40);

function worker(
  workerId: string,
  input: { chatRelocation?: boolean; online?: boolean } = {},
) {
  return workerSummarySchema.parse({
    workerId,
    name: workerId,
    platform: "linux",
    architecture: "x64",
    codexVersion: "0.146.1",
    chatRelocation: input.chatRelocation ?? true,
    online: input.online ?? true,
    lastSeenAt: now,
    startedAt: now,
  });
}

function replica(workerId: string, primaryWorktreeId: string) {
  return projectReplicaSummarySchema.parse({
    id: `replica-${workerId}`,
    projectId: "project-one",
    workerId,
    workerName: workerId,
    workerOnline: true,
    path: `/repo/${workerId}`,
    displayPath: workerId,
    repositoryFingerprint: "github.com/arcanearts/cantrip",
    primaryWorktreeId,
    branch: "main",
    head: sourceRevision,
    dirty: false,
    ready: true,
    worktreeCount: 1,
    lastObservedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

function worktree(
  id: string,
  workerId: string,
  input: { head?: string | null; primary?: boolean } = {},
) {
  return projectWorktreeSummarySchema.parse({
    id,
    projectSourceId: `replica-${workerId}`,
    projectId: "project-one",
    workerId,
    name: input.primary === false ? "feature" : "Primary",
    path: `/repo/${workerId}/${id}`,
    displayPath: id,
    isPrimary: input.primary ?? true,
    isDefault: input.primary ?? true,
    origin: input.primary === false ? "agent" : "cantrip",
    lifecycleState: "ready",
    branch: "main",
    head: input.head === undefined ? sourceRevision : input.head,
    detached: false,
    locked: false,
    lockReason: null,
    lastScannedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

const chat = chatSummarySchema.parse({
  id: "chat-one",
  projectId: "project-one",
  title: "Move me",
  position: 0,
  status: "idle",
  activeWorkerId: "source",
  activeWorktreeId: "source-primary",
  placementRevision: 1,
  worktreeMode: "agent-managed",
  modelId: null,
  permissionProfileId: ":workspace",
  planMode: "default",
  hasPendingPlanQuestion: false,
  automationPaused: false,
  createdAt: now,
  updatedAt: now,
});

function placement(): ProjectSurfacePlacementContext {
  return {
    projectId: "project-one",
    workers: [
      worker("source"),
      worker("target", { online: false }),
      worker("legacy", { chatRelocation: false }),
    ],
    replicas: [
      replica("source", "source-primary"),
      replica("target", "target-primary"),
    ],
    worktrees: [
      worktree("source-primary", "source"),
      worktree("target-primary", "target", { head: otherRevision }),
      worktree("target-feature", "target", {
        head: otherRevision,
        primary: false,
      }),
    ],
  };
}

function job(state: ChatRelocationJobSummary["state"], createdAt = now) {
  return chatRelocationJobSummarySchema.parse({
    id:
      state === "succeeded"
        ? "22222222-2222-4222-8222-222222222222"
        : "11111111-1111-4111-8111-111111111111",
    projectId: "project-one",
    chatId: "chat-one",
    state,
    stateRevision: 2,
    idempotencyKey: `move-${state}`,
    sourcePlacement: {
      projectId: "project-one",
      workerId: "source",
      projectReplicaId: "replica-source",
      worktreeId: "source-primary",
      surface: { kind: "chat", id: "chat-one" },
    },
    sourcePlacementRevision: 1,
    targetPlacement: {
      projectId: "project-one",
      workerId: "target",
      projectReplicaId: "replica-target",
      worktreeId: "target-primary",
      surface: { kind: "chat", id: "chat-one" },
    },
    contextSnapshotId: "11111111-1111-4111-8111-111111111111",
    targetRuntimeThreadId: null,
    targetModelRouteId: null,
    attempt: 1,
    progress: {
      stage: state,
      percent: state === "succeeded" ? 100 : 35,
      message: state === "blocked" ? "Target worker is offline." : "Ready.",
      updatedAt: now,
    },
    error:
      state === "blocked"
        ? {
            code: "worker-offline",
            message: "Target worker is offline.",
            retryable: true,
          }
        : null,
    createdAt,
    updatedAt: createdAt,
    startedAt: now,
    cancellationUnsafeAt: null,
    completedAt: state === "succeeded" ? createdAt : null,
  });
}

describe("chat relocation UI model", () => {
  it("explains revision policy and keeps offline durable targets selectable", () => {
    const disabled = chatRelocationTargetWorkers({
      chat,
      placement: placement(),
      statuses: {},
      synchronizationPolicy: "off",
    });
    expect(disabled.map(({ worker }) => worker.workerId)).toEqual([
      "legacy",
      "target",
    ]);
    expect(disabled[0]).toMatchObject({ reason: "Upgrade required" });
    expect(disabled[1]?.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          disabled: true,
          reason: "Revision differs; safe Primary sync is off",
          worktree: expect.objectContaining({ id: "target-primary" }),
        }),
        expect.objectContaining({
          disabled: true,
          reason: "Revision differs; reconcile this worktree first",
          worktree: expect.objectContaining({ id: "target-feature" }),
        }),
      ]),
    );

    const safeSync = chatRelocationTargetWorkers({
      chat,
      placement: placement(),
      statuses: {},
      synchronizationPolicy: "fast-forward-primary",
    });
    expect(
      safeSync
        .find(({ worker }) => worker.workerId === "target")
        ?.worktrees.find(({ worktree }) => worktree.id === "target-primary"),
    ).toMatchObject({
      disabled: false,
      detail: `Will safely synchronize to ${sourceRevision.slice(0, 10)}`,
    });

    const unknownRevision = placement();
    unknownRevision.worktrees = unknownRevision.worktrees.map((candidate) =>
      candidate.id === "target-primary"
        ? worktree("target-primary", "target", { head: null })
        : candidate,
    );
    expect(
      chatRelocationTargetWorkers({
        chat,
        placement: unknownRevision,
        statuses: {},
        synchronizationPolicy: "fast-forward-primary",
      })
        .find(({ worker }) => worker.workerId === "target")
        ?.worktrees.find(({ worktree }) => worktree.id === "target-primary"),
    ).toMatchObject({
      disabled: true,
      reason: "Refresh this worktree so its Git revision can be verified",
    });
  });

  it("blocks dirty source and target worktrees before submission", () => {
    const statuses: WorktreeStatusMap = {
      "source-primary": {
        branch: "main",
        head: sourceRevision,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        files: [
          {
            path: "source.ts",
            originalPath: null,
            indexStatus: "M",
            worktreeStatus: " ",
            staged: true,
            unstaged: false,
          },
        ],
        branches: [],
      },
      "target-primary": {
        branch: "main",
        head: otherRevision,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        files: [
          {
            path: "target.ts",
            originalPath: null,
            indexStatus: " ",
            worktreeStatus: "M",
            staged: false,
            unstaged: true,
          },
        ],
        branches: [],
      },
    };
    expect(chatRelocationSourceIssue(chat, placement(), statuses)).toMatch(
      /current worktree changes/iu,
    );
    expect(
      chatRelocationTargetWorkers({
        chat,
        placement: placement(),
        statuses,
        synchronizationPolicy: "fast-forward-primary",
      })
        .find(({ worker }) => worker.workerId === "target")
        ?.worktrees.find(({ worktree }) => worktree.id === "target-primary"),
    ).toMatchObject({ disabled: true, reason: "Local changes" });
  });

  it("keeps blocked jobs active while presenting the latest terminal result", () => {
    const blocked = job("blocked");
    const succeeded = job("succeeded", "2026-08-12T12:01:00.000Z");
    expect(activeChatRelocationJob([blocked, succeeded])?.id).toBe(blocked.id);
    expect(latestChatRelocationJob([blocked, succeeded])?.id).toBe(
      succeeded.id,
    );
    const markup = renderToStaticMarkup(<ChatRelocationStatus job={blocked} />);
    expect(markup).toContain("Moving chat · blocked");
    expect(markup).toContain("Target worker is offline.");
    expect(markup).toContain("35%");
  });
});
