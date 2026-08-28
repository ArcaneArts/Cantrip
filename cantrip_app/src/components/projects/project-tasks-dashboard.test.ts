import type { TaskDetail } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { taskCanBeDeleted } from "../tasks/task-deletion";
import {
  projectTaskDashboardQueriesEnabled,
  projectTaskIsUnqueuedDraft,
  projectTaskWorkloadPresentation,
  sortProjectTaskWorkload,
  type ProjectTaskWorkloadItem,
} from "./project-tasks-dashboard";

function task(input: {
  chatId: string;
  createdAt: string;
  priority?: number;
  state: TaskDetail["state"];
  completedAt?: string;
}): TaskDetail {
  return {
    chatId: input.chatId,
    planGoalEnabled: false,
    priority: input.priority ?? 0,
    requestedTaskWorkerId: null,
    continuityFamily: null,
    lastTaskWorkerId: null,
    dispatch: null,
    state: input.state,
    stableStateBeforeFailure: null,
    activeOperationId: null,
    activeOperationKind: null,
    briefMarkdown: input.chatId,
    draftAttachmentIds: [],
    planMarkdown: null,
    planAuthorship: "agent",
    currentQuestions: [],
    currentAnswers: [],
    additionalDirection: "",
    finalPlanMarkdown: null,
    goalPrompt: null,
    planningRound: 0,
    implementationStartedAt: null,
    completedAt: input.completedAt ?? null,
    lastError: null,
    schedulerRevision: 1,
    rowVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.completedAt ?? input.createdAt,
  };
}

function item(value: TaskDetail): ProjectTaskWorkloadItem {
  return {
    task: value,
    plan: { mode: "default", explanation: null, question: null, steps: [] },
    messages: [],
  };
}

function dispatch(
  value: TaskDetail,
  state: NonNullable<TaskDetail["dispatch"]>["state"],
): TaskDetail {
  value.dispatch = {
    id: "00000000-0000-4000-8000-000000000001",
    chatId: value.chatId,
    operationId: "operation",
    operationKind: "direct",
    state,
    fifoCreatedAt: value.createdAt,
    requestedTaskWorkerId: null,
    selectedTaskWorkerId: null,
    taskWorkerRevision: null,
    continuityFamily: null,
    modelConfiguration: null,
    modelRouteId: null,
    providerAccountId: null,
    physicalWorkerId: null,
    worktreeId: null,
    codexThreadId: null,
    turnId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    fencingToken: 0,
    attemptCount: 0,
    eligibilityCode: state === "queued" ? "project-paused" : null,
    queuedAt: value.createdAt,
    claimedAt: null,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    createdAt: value.createdAt,
    updatedAt: value.createdAt,
  };
  return value;
}

describe("project Task workload", () => {
  it("distinguishes an unqueued draft from a queued Task", () => {
    const draft = task({
      chatId: "draft",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "draft",
    });
    const queued = dispatch(
      task({
        chatId: "queued",
        createdAt: "2026-08-24T12:00:00.000Z",
        state: "draft",
      }),
      "queued",
    );

    expect(projectTaskIsUnqueuedDraft(draft)).toBe(true);
    expect(projectTaskIsUnqueuedDraft(queued)).toBe(false);
    expect(projectTaskIsUnqueuedDraft(undefined)).toBe(false);
  });

  it("allows deletion only for unqueued drafts, queued Tasks, and failed Tasks", () => {
    const draft = task({
      chatId: "draft",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "draft",
    });
    const queued = dispatch(
      task({
        chatId: "queued",
        createdAt: "2026-08-24T12:00:00.000Z",
        state: "draft",
      }),
      "queued",
    );
    const failed = task({
      chatId: "failed",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "failed",
    });
    const staleFailed = dispatch(
      task({
        chatId: "stale-failed",
        createdAt: "2026-08-24T12:00:00.000Z",
        state: "failed",
      }),
      "running",
    );
    const running = dispatch(
      task({
        chatId: "running",
        createdAt: "2026-08-24T12:00:00.000Z",
        state: "planning",
      }),
      "running",
    );
    const complete = task({
      chatId: "complete",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "complete",
    });

    expect(taskCanBeDeleted(draft)).toBe(true);
    expect(taskCanBeDeleted(queued)).toBe(true);
    expect(taskCanBeDeleted(failed)).toBe(true);
    expect(taskCanBeDeleted(staleFailed)).toBe(true);
    expect(taskCanBeDeleted(running)).toBe(false);
    expect(taskCanBeDeleted(complete, "failed")).toBe(false);
    expect(taskCanBeDeleted(undefined)).toBe(false);
  });

  it("loads dashboard-only queries only while the task list is visible", () => {
    expect(projectTaskDashboardQueriesEnabled(true, null)).toBe(true);
    expect(projectTaskDashboardQueriesEnabled(false, null)).toBe(false);
    expect(projectTaskDashboardQueriesEnabled(true, "active-task")).toBe(false);
  });

  it("puts attention before running and queued while sorting each band by priority then newest creation", () => {
    const items = [
      item(
        dispatch(
          task({
            chatId: "queued-new",
            createdAt: "2026-08-24T12:00:00.000Z",
            state: "draft",
          }),
          "queued",
        ),
      ),
      item(
        dispatch(
          task({
            chatId: "running",
            createdAt: "2026-08-24T13:00:00.000Z",
            state: "planning",
          }),
          "running",
        ),
      ),
      item(
        task({
          chatId: "attention-high",
          createdAt: "2026-08-23T12:00:00.000Z",
          priority: 10,
          state: "review",
        }),
      ),
      item(
        task({
          chatId: "attention-new",
          createdAt: "2026-08-24T12:00:00.000Z",
          state: "review",
        }),
      ),
      item(
        task({
          chatId: "complete-old",
          completedAt: "2026-08-20T12:00:00.000Z",
          createdAt: "2026-08-19T12:00:00.000Z",
          state: "complete",
        }),
      ),
      item(
        task({
          chatId: "complete-new",
          completedAt: "2026-08-24T12:00:00.000Z",
          createdAt: "2026-08-18T12:00:00.000Z",
          state: "complete",
        }),
      ),
    ];

    const sorted = sortProjectTaskWorkload(items, new Map(), false);

    expect(sorted.active.map(({ task: value }) => value.chatId)).toEqual([
      "attention-high",
      "attention-new",
      "running",
      "queued-new",
    ]);
    expect(sorted.completed.map(({ task: value }) => value.chatId)).toEqual([
      "complete-new",
      "complete-old",
    ]);
  });

  it("keeps a paused queued Task in its queued band with a paused overlay", () => {
    const value = task({
      chatId: "paused-queued",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "draft",
    });
    dispatch(value, "queued");

    expect(
      projectTaskWorkloadPresentation(value, undefined, true),
    ).toMatchObject({ band: "queued", label: "Paused · queued", paused: true });
  });

  it("surfaces an expired started cycle as needing recovery", () => {
    const value = task({
      chatId: "expired-running",
      createdAt: "2026-08-24T12:00:00.000Z",
      state: "planning",
    });
    dispatch(value, "expired");

    expect(
      projectTaskWorkloadPresentation(value, undefined, false),
    ).toMatchObject({ band: "attention", label: "Needs recovery" });
  });
});
