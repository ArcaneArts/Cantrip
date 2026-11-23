import {
  createModelRoutingRuntime,
  type ModelRoutingRuntimeDependencies,
} from "../src/app/runtime/model-routing-runtime.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, or, sql } from "drizzle-orm";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import type { NativeTurnModelAttribution } from "@cantrip/protocol";
import { TelemetryRepository } from "../src/db/repository/telemetry.js";
let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
let anchor: string;
let capture: NativeTurnModelAttribution;
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
  const [runtime] = await fixture.repository.getModelRuntimes(LOCAL_USER_ID);
  anchor = runtime!.routeId;
  await fixture.db.insert(schema.modelRoutes).values({
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
      workerId: fixture.workerId,
      providerId: runtime!.provider.id,
      providerAccountId: null,
      modelId: runtime!.model.id,
      routeId: "chosen-route",
    },
  };
}, 60000);
beforeEach(async () => {
  await fixture.db.delete(schema.tokenUsageRecords);
});
afterAll(async () => {
  await fixture?.close();
});
const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
const write = (sourceKey: string, extra: Record<string, unknown> = {}) =>
  fixture.repository.recordTokenUsage(LOCAL_USER_ID, {
    sourceKey,
    projectId: null,
    chatId: fixture.chatId,
    modelRouteId: anchor,
    workerId: fixture.workerId,
    turnId: "native-turn",
    providerAccountId: null,
    attemptStatus: "running",
    reasoningEffort: "high",
    ...extra,
  });
const read = async (sourceKey: string) =>
  (
    await fixture.db
      .select()
      .from(schema.tokenUsageRecords)
      .where(
        or(
          eq(schema.tokenUsageRecords.sourceKey, sourceKey),
          sql`${schema.tokenUsageRecords.sourceAliases} @> ${JSON.stringify([sourceKey])}::jsonb`,
        ),
      )
  )[0]!;
describe("native turn model usage attribution", () => {
  it("preserves captured non-chat usage without requiring a managed chat", async () => {
    await write("task", {
      chatId: null,
      nativeModelAttribution: capture,
      usage,
    });
    await write("task", { chatId: null, attemptStatus: "completed" });
    expect(await read("task")).toMatchObject({
      sourceKey: "task",
      chatId: null,
      nativeModelAttribution: capture,
      outputTokens: 3,
      attemptStatus: "completed",
    });
  });
  it("finds pre-migration captured usage when recovery has never seen its live source name", async () => {
    await write("old-gui", { nativeModelAttribution: capture, usage });
    const retained = await read("old-gui");
    await fixture.db
      .update(schema.tokenUsageRecords)
      .set({ sourceKey: "old-gui", sourceAliases: [] })
      .where(eq(schema.tokenUsageRecords.id, retained.id));
    await fixture.restart();
    await write("new-history", { nativeModelAttribution: capture, usage });
    const rows = await fixture.db.select().from(schema.tokenUsageRecords);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: retained.id,
      outputTokens: 3,
      sourceAliases: ["new-history", "old-gui"],
    });
  });
  it("reconciles live and recovered source names into one durable row", async () => {
    const startedAt = new Date("2026-09-09T12:00:00Z");
    const completedAt = new Date("2026-09-09T12:00:10Z");
    await write("gui", { nativeModelAttribution: capture, usage, startedAt });
    await write("history", { nativeModelAttribution: capture, usage });
    const rows = await fixture.db.select().from(schema.tokenUsageRecords);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      sourceAliases: ["gui", "history"],
    });
    await fixture.restart();
    await write("gui", {
      attemptStatus: "completed",
      completedAt,
      usage: { ...usage, outputTokens: 7 },
    });
    expect(await read("history")).toMatchObject({
      id: rows[0]!.id,
      outputTokens: 7,
      attemptStatus: "completed",
    });
    const analytics = await new TelemetryRepository(
      fixture.db,
    ).getAgentTimeAnalytics(LOCAL_USER_ID, undefined, completedAt);
    expect(analytics.total).toMatchObject({
      activeAgentCount: 0,
      agentTimeMs: 10000,
      wallTimeMs: 10000,
      averageConcurrency: 1,
    });
  });
  it("adopts a pending zero-count attempt when history already captured its turn", async () => {
    await write("gui", { turnId: null });
    await write("history", { nativeModelAttribution: capture, usage });
    await write("gui", { nativeModelAttribution: capture });
    expect(
      await fixture.db.select().from(schema.tokenUsageRecords),
    ).toHaveLength(1);
    expect(await read("gui")).toMatchObject({
      nativeModelAttribution: capture,
      outputTokens: 3,
    });
  });
  it("retains each native turn in an attempt and resolves exact late finalization", async () => {
    await write("attempt", { nativeModelAttribution: capture, usage });
    const first = await read("attempt");
    const next = { ...capture, turnId: "next-native-turn" };
    await write("attempt", {
      turnId: next.turnId,
      nativeModelAttribution: next,
      usage: { ...usage, outputTokens: 8 },
    });
    await write("attempt", { attemptStatus: "completed" });
    const rows = await fixture.db.select().from(schema.tokenUsageRecords);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.id)).toMatchObject({
      turnId: capture.turnId,
      outputTokens: 3,
      attemptStatus: "completed",
    });
    expect(rows.find((row) => row.turnId === next.turnId)).toMatchObject({
      outputTokens: 8,
      attemptStatus: "running",
    });
    await expect(
      write("attempt", { turnId: null, attemptStatus: "failed" }),
    ).rejects.toThrow("multiple native turns");
    expect(await fixture.db.select().from(schema.tokenUsageRecords)).toEqual(
      rows,
    );
  });
  it("serializes concurrent observations of the same native turn", async () => {
    await Promise.all(
      ["gui", "cli", "history"].map((source) =>
        write(source, { nativeModelAttribution: capture, usage }),
      ),
    );
    const rows = await fixture.db.select().from(schema.tokenUsageRecords);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outputTokens: 3,
      sourceAliases: ["cli", "gui", "history"],
    });
  });
  it("rolls back alias adoption when captured settings conflict", async () => {
    await write("gui", { nativeModelAttribution: capture, usage });
    const before = await fixture.db.select().from(schema.tokenUsageRecords);
    await expect(
      write("history", {
        nativeModelAttribution: { ...capture, reasoningEffort: "medium" },
        usage,
      }),
    ).rejects.toThrow("conflicts");
    expect(await fixture.db.select().from(schema.tokenUsageRecords)).toEqual(
      before,
    );
  });
  it("does not relabel a legacy source key with another owned chat", async () => {
    const [chat] = await fixture.db
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.id, fixture.chatId));
    await fixture.db
      .insert(schema.chats)
      .values({ ...chat!, id: "another-owned-chat" });
    await write("legacy");
    const before = await read("legacy");
    await expect(
      write("legacy", { chatId: "another-owned-chat", usage }),
    ).rejects.toThrow("another chat");
    expect(await read("legacy")).toEqual(before);
  });
  it("does not discard separately measured legacy usage when joining an existing native row", async () => {
    await write("gui", { turnId: null, usage });
    await write("history", { nativeModelAttribution: capture, usage });
    const before = await fixture.db.select().from(schema.tokenUsageRecords);
    await expect(
      write("gui", { nativeModelAttribution: capture }),
    ).rejects.toThrow("Uncorrelated attempt usage");
    expect(await fixture.db.select().from(schema.tokenUsageRecords)).toEqual(
      before,
    );
  });
  it("rejects a canonical source key belonging to another native identity", async () => {
    await expect(
      write('native-turn:["another-chat","native-thread","native-turn"]', {
        nativeModelAttribution: capture,
        usage,
      }),
    ).rejects.toThrow("another turn");
    expect(
      await fixture.db.select().from(schema.tokenUsageRecords),
    ).toHaveLength(0);
  });
  it("replaces bootstrap attribution with actual native capture and preserves it through final usage, status updates and restart", async () => {
    await write("root");
    expect((await read("root")).modelRouteId).toBe(anchor);
    await write("root", { nativeModelAttribution: capture, usage });
    await write("root", {
      attemptStatus: "completed",
      usage: { ...usage, outputTokens: 7, totalTokens: 9 },
    });
    await write("root", { attemptStatus: "completed", turnId: null });
    const retained = await read("root");
    expect(retained).toMatchObject({
      modelRouteId: "chosen-route",
      reasoningEffort: "low",
      turnId: "native-turn",
      outputTokens: 7,
      nativeModelAttribution: capture,
    });
    await fixture.restart();
    expect(await read("root")).toEqual(retained);
  });
  it("does not relabel an unresolved native selection with bootstrap defaults", async () => {
    const unavailable = { ...capture, selection: { status: "unavailable" } };
    await write("unknown", { nativeModelAttribution: unavailable, usage });
    await write("unknown", { attemptStatus: "completed", usage });
    expect(await read("unknown")).toMatchObject({
      modelId: null,
      modelRouteId: null,
      nativeModelAttribution: unavailable,
      inputTokens: 2,
    });
  });
  it("rejects conflicting immutable capture without changing the previous counts or model", async () => {
    await write("conflict", { nativeModelAttribution: capture, usage });
    const before = await read("conflict");
    await expect(
      write("conflict", {
        nativeModelAttribution: { ...capture, reasoningEffort: "medium" },
        usage: { ...usage, outputTokens: 99 },
      }),
    ).rejects.toThrow(/conflicts|another retained turn/);
    expect(await read("conflict")).toEqual(before);
  });
  it("routes child usage into a separate record without overwriting root usage", async () => {
    const [runtime] = await fixture.repository.getModelRuntimes(LOCAL_USER_ID);
    const warn = vi.fn();
    const routing = createModelRoutingRuntime({
      repository: fixture.repository,
      applicationOwnerId: () => LOCAL_USER_ID,
      app: { log: { warn } },
      publishProjectTokenUsageChange: vi.fn(),
    } as unknown as ModelRoutingRuntimeDependencies);
    await routing.recordRuntimeTokenUsage(
      "routing",
      null,
      fixture.chatId,
      runtime!,
      usage,
      {
        workerId: fixture.workerId,
        turnId: capture.turnId,
        nativeModelAttribution: capture,
      },
    );
    const child = {
      ...capture,
      isRoot: false,
      threadId: "child-thread",
      turnId: "child-turn",
    };
    await routing.recordRuntimeTokenUsage(
      "routing",
      null,
      fixture.chatId,
      runtime!,
      { ...usage, outputTokens: 7 },
      {
        workerId: fixture.workerId,
        turnId: child.turnId,
        nativeModelAttribution: child,
      },
    );
    expect(warn).not.toHaveBeenCalled();
    expect(await read("routing")).toMatchObject({
      nativeModelAttribution: capture,
      outputTokens: 3,
    });
    expect(
      await read('routing:native-child:["child-thread","child-turn"]'),
    ).toMatchObject({ nativeModelAttribution: child, outputTokens: 7 });
  });
  it("rejects stale status/usage updates for another turn after a capture", async () => {
    await write("late", { nativeModelAttribution: capture, usage });
    const before = await read("late");
    await expect(
      write("late", { turnId: "other", usage: { ...usage, outputTokens: 99 } }),
    ).rejects.toThrow(/conflicts|another retained turn/);
    expect(await read("late")).toEqual(before);
  });
  it("captures zero-token work and does not reopen a terminal record when start telemetry arrives late", async () => {
    await write("zero", { attemptStatus: "failed" });
    await write("zero", { nativeModelAttribution: capture });
    expect(await read("zero")).toMatchObject({
      modelRouteId: "chosen-route",
      attemptStatus: "failed",
      inputTokens: 0,
      outputTokens: 0,
      nativeModelAttribution: capture,
    });
  });
  it("joins captured child counts with the existing child finalization identity", async () => {
    const [runtime] = await fixture.repository.getModelRuntimes(LOCAL_USER_ID);
    const warn = vi.fn();
    const routing = createModelRoutingRuntime({
      repository: fixture.repository,
      applicationOwnerId: () => LOCAL_USER_ID,
      app: { log: { warn } },
      publishProjectTokenUsageChange: vi.fn(),
    } as unknown as ModelRoutingRuntimeDependencies);
    const child = {
      ...capture,
      isRoot: false,
      threadId: "child",
      turnId: "turn-child",
    };
    await routing.recordRuntimeTokenUsage(
      "chat-attempt:parent",
      null,
      fixture.chatId,
      runtime!,
      usage,
      {
        workerId: fixture.workerId,
        turnId: child.turnId,
        executionAttemptId: "parent",
        attemptKind: "chat-turn",
        attemptStatus: "running",
        nativeModelAttribution: child,
      },
    );
    await routing.recordRuntimeTokenUsage(
      "chat-subagent:parent:subagent:child:turn-child",
      null,
      fixture.chatId,
      runtime!,
      undefined,
      {
        workerId: fixture.workerId,
        turnId: child.turnId,
        executionAttemptId: "parent:subagent:child:turn-child",
        attemptKind: "subagent-turn",
        attemptStatus: "completed",
      },
    );
    expect(warn).not.toHaveBeenCalled();
    expect(
      await read("chat-subagent:parent:subagent:child:turn-child"),
    ).toMatchObject({
      modelRouteId: "chosen-route",
      attemptStatus: "completed",
      inputTokens: 2,
      outputTokens: 3,
      nativeModelAttribution: child,
    });
    expect(await read("chat-attempt:parent")).toBeUndefined();
  });
  it.each([
    "workerId",
    "providerAccountId",
    "providerId",
    "modelId",
    "routeId",
  ])(
    "rejects %s outside the authenticated session/provider scope",
    async (field) => {
      await expect(
        write("wrong-" + field, {
          nativeModelAttribution: {
            ...capture,
            selection: { ...capture.selection, [field]: "wrong" },
          },
          usage,
        }),
      ).rejects.toThrow();
      expect(await read("wrong-" + field)).toBeUndefined();
    },
  );
  it("rejects a different native turn", async () => {
    await expect(
      write("wrong-turn", {
        nativeModelAttribution: { ...capture, turnId: "other" },
      }),
    ).rejects.toThrow("another turn");
  });
});
