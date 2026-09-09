import {
  createModelRoutingRuntime,
  type ModelRoutingRuntimeDependencies,
} from "../src/app/runtime/model-routing-runtime.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import type { NativeTurnModelAttribution } from "@cantrip/protocol";
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
      .where(eq(schema.tokenUsageRecords.sourceKey, sourceKey))
  )[0]!;
describe("native turn model usage attribution", () => {
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
    ).rejects.toThrow("conflicts");
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
    ).rejects.toThrow("conflicts");
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
