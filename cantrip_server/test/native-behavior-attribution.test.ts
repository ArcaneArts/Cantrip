import {
  createModelRoutingRuntime,
  type ModelRoutingRuntimeDependencies,
} from "../src/app/runtime/model-routing-runtime.js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  emptyNativeBehaviorAttribution,
  providerTelemetryExportSchema,
  type NativeBehaviorAttribution,
  type NativeTurnModelAttribution,
} from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import { ModelBehaviorTracker } from "../src/analytics/model-behavior.js";
import type { ModelBehaviorObservationInput } from "../src/db/repository/telemetry.js";
let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
let anchor: string;
let capture: NativeTurnModelAttribution;
beforeAll(async () => {
  f = await createNativeSettingsFixture();
  const [runtime] = await f.repository.getModelRuntimes(LOCAL_USER_ID);
  anchor = runtime!.routeId;
  await f.db.insert(schema.modelRoutes).values({
    id: "chosen-route",
    modelId: runtime!.model.id,
    providerId: runtime!.provider.id,
    modelName: "chosen",
    position: 99,
  });
  capture = {
    threadId: "native-thread",
    turnId: "native-turn",
    isRoot: true,
    reasoningEffort: "low",
    selection: {
      status: "resolved",
      workerId: f.workerId,
      providerId: runtime!.provider.id,
      providerAccountId: null,
      modelId: runtime!.model.id,
      routeId: "chosen-route",
    },
  };
}, 60000);
beforeEach(async () => {
  await f.db.delete(schema.modelBehaviorObservations);
});
afterAll(async () => {
  await f?.close();
});
const evidence = (
  ...captures: NativeTurnModelAttribution[]
): NativeBehaviorAttribution => ({
  version: 1,
  turnIds: captures.map((capture) => capture.turnId),
  captures,
  conflictingTurnKeys: [],
});
const write = (extra: Partial<ModelBehaviorObservationInput> = {}) =>
  f.repository.recordModelBehaviorObservation(LOCAL_USER_ID, {
    sourceKey: "attempt",
    projectId: null,
    chatId: f.chatId,
    executionAttemptId: "attempt",
    modelRouteId: anchor,
    workerId: f.workerId,
    providerAccountId: null,
    attemptStatus: "running",
    reasoningEffort: "high",
    ...extra,
  });
const row = async () =>
  (await f.db.select().from(schema.modelBehaviorObservations))[0]!;
it("starts unknown, uses actual capture, and retains it after late bootstrap and restart", async () => {
  await write({ nativeAttribution: emptyNativeBehaviorAttribution() });
  expect(await row()).toMatchObject({
    modelId: null,
    modelRouteId: null,
    reasoningEffort: null,
  });
  await write({ nativeAttribution: evidence(capture), toolCallCount: 2 });
  await write({
    attemptStatus: "completed",
    toolCallCount: 2,
    finalizedAt: new Date(),
    turnId: "native-turn",
  });
  expect(await row()).toMatchObject({
    modelRouteId: "chosen-route",
    reasoningEffort: "low",
    toolCallCount: 2,
    nativeAttribution: evidence(capture),
  });
  const saved = await row();
  await f.restart();
  expect(await row()).toEqual(saved);
  const exported = await f.repository.exportProviderTelemetry(
    LOCAL_USER_ID,
    capture.selection.status === "resolved" ? capture.selection.providerId : "",
  );
  expect(
    providerTelemetryExportSchema.parse(exported).modelBehavior[0]!
      .nativeAttribution,
  ).toEqual(evidence(capture));
});
it("retains partial coverage and does not call missing reasoning provider-default", async () => {
  await write({
    nativeAttribution: {
      ...evidence(capture),
      turnIds: ["native-turn", "not-captured"],
    },
  });
  expect(await row()).toMatchObject({
    modelId: null,
    reasoningEffort: null,
    signalAvailability: {
      nativeModelKnown: false,
      nativeReasoningKnown: false,
    },
  });
  const dashboard =
    await f.repository.getProviderTelemetryAnalytics(LOCAL_USER_ID);
  expect(dashboard.behavior.reasoningEfforts).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: "unattributed" })]),
  );
  await write({
    nativeAttribution: evidence({ ...capture, turnId: "not-captured" }),
  });
  expect(await row()).toMatchObject({
    modelRouteId: "chosen-route",
    reasoningEffort: "low",
    turnId: null,
  });
});
it("retains both captures from concurrent writes and clears mixed-model attribution", async () => {
  if (capture.selection.status !== "resolved") throw new Error("fixture");
  const child = {
    ...capture,
    threadId: "child-thread",
    turnId: "child-turn",
    isRoot: false,
    reasoningEffort: "high",
    selection: { ...capture.selection, routeId: anchor },
  };
  await Promise.all([
    write({ nativeAttribution: evidence(capture) }),
    write({ nativeAttribution: evidence(child) }),
  ]);
  expect((await row()).nativeAttribution!.captures).toHaveLength(2);
  expect(await row()).toMatchObject({
    modelId: null,
    modelRouteId: null,
    reasoningEffort: null,
    turnId: null,
  });
  await write({
    nativeAttribution: evidence(capture),
    attemptStatus: "completed",
  });
  expect((await row()).nativeAttribution!.captures).toHaveLength(2);
  expect((await row()).modelId).toBeNull();
});
it("keeps conflicting captures explicit instead of selecting the last model", async () => {
  await write({ nativeAttribution: evidence(capture) });
  await write({
    nativeAttribution: evidence({ ...capture, reasoningEffort: "high" }),
  });
  expect((await row()).nativeAttribution!.conflictingTurnKeys).toEqual([
    JSON.stringify([capture.threadId, capture.turnId]),
  ]);
  expect(await row()).toMatchObject({ modelId: null, reasoningEffort: null });
  await write({ nativeAttribution: evidence(capture) });
  expect((await row()).modelId).toBeNull();
});
it("keeps finalized observations terminal while enriching late capture", async () => {
  await write({
    nativeAttribution: {
      ...emptyNativeBehaviorAttribution(),
      turnIds: ["native-turn"],
    },
    attemptStatus: "completed",
    toolCallCount: 8,
    finalAnswerAppeared: true,
  });
  await write({ nativeAttribution: evidence(capture), toolCallCount: 0 });
  expect(await row()).toMatchObject({
    attemptStatus: "completed",
    toolCallCount: 8,
    finalAnswerAppeared: true,
    modelRouteId: "chosen-route",
  });
});
it("rejects foreign worker/account and source reuse without changing the retained row", async () => {
  await write({ nativeAttribution: evidence(capture) });
  const saved = await row();
  await expect(
    write({ workerId: "foreign", nativeAttribution: evidence(capture) }),
  ).rejects.toThrow("worker/account");
  await expect(
    write({
      providerAccountId: "foreign",
      nativeAttribution: evidence(capture),
    }),
  ).rejects.toThrow("worker/account");
  await expect(write({ executionAttemptId: "another" })).rejects.toThrow(
    "different attempt",
  );
  expect(await row()).toEqual(saved);
});
it("rolls back a real failed write and retries without duplicate capture", async () => {
  await f.db.execute(
    sql`ALTER TABLE model_behavior_observations ADD CONSTRAINT reject_native_behavior CHECK (native_attribution IS NULL)`,
  );
  try {
    await expect(
      write({ nativeAttribution: evidence(capture) }),
    ).rejects.toThrow();
  } finally {
    await f.db.execute(
      sql`ALTER TABLE model_behavior_observations DROP CONSTRAINT reject_native_behavior`,
    );
  }
  expect(await row()).toBeUndefined();
  await write({ nativeAttribution: evidence(capture) });
  await write({ nativeAttribution: evidence(capture) });
  expect((await row()).nativeAttribution!.captures).toHaveLength(1);
});
it("tracks protected and visible native observations without decoding message content", async () => {
  const tracker = new ModelBehaviorTracker();
  tracker.observeNativeEvent({
    type: "agent.protected-message",
    telemetry: {
      kind: "message",
      turnId: "native-turn",
      phase: "final_answer",
    },
    message: {},
  } as never);
  expect(tracker.snapshot().nativeAttribution).toMatchObject({
    turnIds: ["native-turn"],
    captures: [],
  });
  tracker.observeNativeEvent({
    type: "agent.protected-message",
    telemetry: {
      kind: "usage",
      turnId: "native-turn",
      nativeModelAttribution: capture,
    },
    message: {},
  } as never);
  tracker.observeNativeEvent({
    type: "agent.activity",
    activity: {
      type: "turnSummary",
      correlation: { turnId: "native-turn" },
      nativeModelAttribution: capture,
    },
  } as never);
  expect(tracker.snapshot().nativeAttribution).toEqual(evidence(capture));
  const exposed = tracker.snapshot();
  exposed.nativeAttribution.captures.length = 0;
  expect(tracker.snapshot().nativeAttribution.captures).toHaveLength(1);
});
it("preserves captured labels after route deletion without falling back to the anchor", async () => {
  await write({ nativeAttribution: evidence(capture) });
  const [route] = await f.db
    .select()
    .from(schema.modelRoutes)
    .where(eq(schema.modelRoutes.id, "chosen-route"));
  await f.db
    .delete(schema.modelRoutes)
    .where(eq(schema.modelRoutes.id, "chosen-route"));
  try {
    await write({ attemptStatus: "completed" });
    expect(await row()).toMatchObject({
      modelRouteId: null,
      reasoningEffort: "low",
    });
  } finally {
    await f.db.insert(schema.modelRoutes).values(route!);
  }
});

it("passes actual captures through the live runtime wrapper into durable observations", async () => {
  const [runtime] = await f.repository.getModelRuntimes(LOCAL_USER_ID);
  const warn = vi.fn();
  const routing = createModelRoutingRuntime({
    repository: f.repository,
    applicationOwnerId: () => LOCAL_USER_ID,
    app: { log: { warn } },
    publishProjectTokenUsageChange: vi.fn(),
  } as unknown as ModelRoutingRuntimeDependencies);
  const tracker = new ModelBehaviorTracker();
  const execution = {
    projectId: null,
    chatId: f.chatId,
    workerId: f.workerId,
  } as never;
  const startedAt = new Date();
  await routing.recordRuntimeModelBehavior(
    "attempt",
    execution,
    runtime!,
    tracker,
    {
      executionAttemptId: "attempt",
      attemptStatus: "running",
      routeAttemptIndex: 0,
      retryFailoverCount: 0,
      startedAt,
    },
  );
  expect((await row()).modelId).toBeNull();
  tracker.observeNativeTurn(capture.turnId, capture);
  await routing.recordRuntimeModelBehavior(
    "attempt",
    execution,
    runtime!,
    tracker,
    {
      executionAttemptId: "attempt",
      attemptStatus: "completed",
      routeAttemptIndex: 0,
      retryFailoverCount: 0,
      startedAt,
    },
  );
  expect(warn).not.toHaveBeenCalled();
  expect(await row()).toMatchObject({
    modelRouteId: "chosen-route",
    reasoningEffort: "low",
    attemptStatus: "completed",
  });
});

it("distinguishes captured default reasoning from missing evidence", async () => {
  await write({
    nativeAttribution: evidence({ ...capture, reasoningEffort: null }),
  });
  const dashboard =
    await f.repository.getProviderTelemetryAnalytics(LOCAL_USER_ID);
  expect(dashboard.behavior.reasoningEfforts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "provider-default" }),
    ]),
  );
});
it("keeps same-named turns in different threads as distinct captured work", async () => {
  await write({
    nativeAttribution: evidence(capture, {
      ...capture,
      threadId: "child",
      isRoot: false,
    }),
  });
  expect((await row()).nativeAttribution!.captures).toHaveLength(2);
  expect((await row()).turnId).toBeNull();
});
