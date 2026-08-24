import { describe, expect, it } from "vitest";

import {
  projectTaskPauseStateSchema,
  taskDispatchFenceSchema,
  taskDispatchCycleSummarySchema,
  taskDispatchWorkerLeaseSchema,
  taskPrioritySchema,
  taskWorkerCreateSchema,
  taskWorkerOrderUpdateSchema,
  taskWorkerUpdateSchema,
} from "../src/task-scheduling.js";

const rootModel = "00000000-0000-4000-8000-000000000101";

describe("Task scheduling contracts", () => {
  it("defaults Task Workers to one Direct-only enabled slot", () => {
    expect(
      taskWorkerCreateSchema.parse({
        name: "Primary",
        modelConfiguration: {
          modelId: rootModel,
          reasoningEffort: "high",
        },
      }),
    ).toMatchObject({
      enabled: true,
      maxConcurrency: 1,
      allowsPlanGoal: false,
      continuityFamilyOverride: null,
      modelConfiguration: {
        modelId: rootModel,
        customSubagentModel: false,
        subagentModelId: null,
      },
    });
  });

  it("requires a root model and bounds concurrency and priority", () => {
    expect(
      taskWorkerCreateSchema.safeParse({
        name: "Missing model",
        modelConfiguration: { modelId: null },
      }).success,
    ).toBe(false);
    expect(
      taskWorkerCreateSchema.safeParse({
        name: "Too broad",
        maxConcurrency: 65,
        modelConfiguration: { modelId: rootModel },
      }).success,
    ).toBe(false);
    expect(taskPrioritySchema.safeParse(1_000_001).success).toBe(false);
    expect(taskPrioritySchema.parse(-10)).toBe(-10);
  });

  it("keeps continuity overrides advanced and normalized by contract", () => {
    expect(
      taskWorkerCreateSchema.parse({
        name: "Grok",
        modelConfiguration: { modelId: rootModel },
        continuityFamilyOverride: "grok",
      }).continuityFamilyOverride,
    ).toBe("grok");
    expect(
      taskWorkerCreateSchema.safeParse({
        name: "Invalid family",
        modelConfiguration: { modelId: rootModel },
        continuityFamilyOverride: "Grok family",
      }).success,
    ).toBe(false);
  });

  it("requires optimistic mutations and complete unique ordering", () => {
    expect(taskWorkerUpdateSchema.safeParse({ rowVersion: 1 }).success).toBe(
      false,
    );
    expect(
      taskWorkerOrderUpdateSchema.safeParse({
        ids: [rootModel, rootModel],
      }).success,
    ).toBe(false);
  });

  it("validates lease snapshots without exposing protected Task content", () => {
    const cycle = taskDispatchCycleSummarySchema.parse({
      id: "00000000-0000-4000-8000-000000000201",
      chatId: "chat-1",
      operationId: "operation-1",
      operationKind: "initial-plan",
      state: "queued",
      fifoCreatedAt: "2026-08-24T00:00:00.000Z",
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
      eligibilityCode: null,
      queuedAt: "2026-08-24T00:00:00.000Z",
      claimedAt: null,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(cycle).not.toHaveProperty("prompt");
    expect(cycle.operationKind).toBe("initial-plan");
  });

  it("requires complete positive fencing data for worker dispatches", () => {
    const fence = {
      cycleId: "00000000-0000-4000-8000-000000000201",
      operationId: "operation-1",
      leaseOwner: "scheduler-1",
      fencingToken: 2,
    };
    expect(taskDispatchFenceSchema.parse(fence)).toEqual(fence);
    expect(
      taskDispatchWorkerLeaseSchema.parse({
        ...fence,
        leaseExpiresAt: "2026-08-24T00:01:00.000Z",
      }),
    ).toMatchObject(fence);
    expect(
      taskDispatchFenceSchema.safeParse({ ...fence, fencingToken: 0 }).success,
    ).toBe(false);
  });

  it("versions Project Task pause state independently", () => {
    expect(
      projectTaskPauseStateSchema.parse({
        projectId: "project-1",
        paused: false,
        pausedAt: null,
        rowVersion: 1,
      }),
    ).toMatchObject({ paused: false, rowVersion: 1 });
  });
});
