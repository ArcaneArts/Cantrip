import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  type NativeHistoryBinding,
  type NativeHistoryUsage,
  type NativeTurnModelAttribution,
} from "@cantrip/protocol";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { TelemetryRepository } from "../src/db/repository/telemetry.js";
import { readChatNativeHistoryTurns } from "../src/db/repository/native-history-turn-read.js";
import { decryptNativeHistoryTurn } from "../../packages/crypto/src/native-history-turn.js";
import { protectNativeHistoryTurnMetadata } from "../../cantrip_worker/src/native-history-turn-content.js";

let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
let binding: NativeHistoryBinding;
let capture: NativeTurnModelAttribution;
let streamId: string;
let sequence = 0;
let previousDigest: string | null = null;
const counts = {
  inputTokens: 2,
  outputTokens: 3,
  totalTokens: 5,
  cachedInputTokens: 1,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 1,
};
const evidence = (ids: string[], complete = true): NativeHistoryUsage => ({
  version: 1,
  responses: ids.map((responseId) => ({ responseId, usage: counts })),
  complete,
  conflictingResponseIds: [],
  modelAttribution: capture,
});
const service = {
  ownerId: () => LOCAL_USER_ID,
  serverIdentity: () => "fixture",
  componentKey: () => ({ key: new Uint8Array(32).fill(9), keyRevision: 1 }),
};
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
  const [runtime] = await fixture.repository.getModelRuntimes(LOCAL_USER_ID);
  const context = await fixture.repository.getChatExecutionContext(
    LOCAL_USER_ID,
    fixture.chatId,
  );
  await fixture.repository.updateChatRuntime(
    fixture.chatId,
    fixture.workerId,
    context!.worktreeId!,
    "native-thread",
    runtime!.routeId,
    "ready",
    null,
  );
  binding = await fixture.repository.nativeHistoryBindings.open(LOCAL_USER_ID, {
    workerId: fixture.workerId,
    chatId: fixture.chatId,
    threadId: "native-thread",
    provenance: { kind: "current" },
  });
  capture = {
    threadId: binding.threadId,
    turnId: "turn",
    isRoot: true,
    reasoningEffort: "low",
    selection: {
      status: "resolved",
      workerId: binding.workerId,
      providerAccountId: binding.providerAccountId,
      providerId: runtime!.provider.id,
      modelId: runtime!.model.id,
      routeId: binding.modelRouteId!,
    },
  };
}, 60000);
beforeEach(async () => {
  await fixture.db.delete(schema.nativeHistoryReceipts);
  await fixture.db.delete(schema.nativeHistoryStreams);
  await fixture.db.delete(schema.nativeHistoryTurns);
  await fixture.db.delete(schema.tokenUsageRecords);
  streamId = randomUUID();
  sequence = 0;
  previousDigest = null;
});
afterAll(async () => {
  await fixture?.close();
});
async function batch(usage: NativeHistoryUsage, timing = true) {
  const next = sequence + 1;
  const turn = await protectNativeHistoryTurnMetadata({
    service,
    binding,
    header: {
      threadId: binding.threadId,
      turnId: "turn",
      revision: next,
      ordinal: 0,
      status: usage.complete ? "completed" : "inProgress",
      startedAtMs: timing ? 1000 : null,
      completedAtMs: timing && usage.complete ? 11000 : null,
      usage,
    },
    content: { private: "retained native source" },
  });
  return {
    workerId: binding.workerId,
    chatId: binding.chatId,
    bindingId: binding.id,
    streamId,
    sequence: next,
    previousDigest,
    recordId: randomUUID(),
    digest: next.toString(16).padStart(64, "0"),
    batch: { items: [], turns: [turn] },
  };
}
async function ingest(usage: NativeHistoryUsage, timing = true) {
  const input = await batch(usage, timing);
  await fixture.repository.nativeHistoryIngestion.ingest(LOCAL_USER_ID, input);
  sequence = input.sequence;
  previousDigest = input.digest;
  return input;
}
async function live(extra: Record<string, unknown> = {}) {
  await fixture.repository.recordTokenUsage(LOCAL_USER_ID, {
    sourceKey: "gui-attempt",
    projectId: binding.projectId,
    chatId: binding.chatId,
    modelRouteId: binding.modelRouteId!,
    workerId: binding.workerId,
    providerAccountId: binding.providerAccountId,
    turnId: "turn",
    nativeModelAttribution: capture,
    attemptStatus: "running",
    executionAttemptId: "logical-attempt",
    attemptKind: "chat-turn",
    usage: counts,
    ...extra,
  });
}
const rows = () => fixture.db.select().from(schema.tokenUsageRecords);

describe("native history usage recovery", () => {
  it("recovers multiple responses without live telemetry and retains them across restart", async () => {
    const input = await ingest(evidence(["one", "two"]));
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      reportedTotalTokens: 10,
      usageSemantics: "native-responses-complete-v1",
      nativeModelAttribution: capture,
    });
    await fixture.restart();
    await fixture.repository.nativeHistoryIngestion.ingest(
      LOCAL_USER_ID,
      input,
    );
    expect(await rows()).toHaveLength(1);
    const time = await new TelemetryRepository(
      fixture.db,
    ).getAgentTimeAnalytics(LOCAL_USER_ID, undefined, new Date(12000));
    expect(time.total.agentTimeMs).toBe(10000);
    const archive = await readChatNativeHistoryTurns(
      fixture.db,
      LOCAL_USER_ID,
      binding.chatId,
      { turns: [{ threadId: binding.threadId, turnId: "turn" }] },
    );
    const archived = archive.turns[0]!;
    expect(archived.turn.usage).toEqual(evidence(["one", "two"]));
    expect(
      await decryptNativeHistoryTurn({
        ownerId: LOCAL_USER_ID,
        serverId: "fixture",
        componentKey: new Uint8Array(32).fill(9),
        chatId: binding.chatId,
        bindingId: binding.id,
        workerId: binding.workerId,
        turn: archived.turn,
      }),
    ).toEqual({ private: "retained native source" });
  });
  it("deduplicates live and recovered usage and prevents last-response finalization from replacing totals", async () => {
    await live();
    await ingest(evidence(["one", "two"]));
    await live({
      nativeModelAttribution: undefined,
      attemptStatus: "completed",
    });
    const retained = (await rows())[0]!;
    expect(await rows()).toHaveLength(1);
    expect(retained).toMatchObject({
      outputTokens: 6,
      executionAttemptId: "logical-attempt",
      attemptKind: "chat-turn",
      attemptStatus: "completed",
    });
    await ingest(evidence(["one"], false));
    expect((await rows())[0]).toEqual({
      ...retained,
      updatedAt: expect.any(Date),
    });
    await ingest(evidence(["one", "two", "three"], false));
    expect((await rows())[0]).toMatchObject({
      outputTokens: 9,
      attemptStatus: "completed",
      reportedTotalTokens: null,
    });
    await live({ nativeModelAttribution: undefined, attemptStatus: "failed" });
    expect((await rows())[0]).toMatchObject({
      outputTokens: 9,
      attemptStatus: "completed",
    });
  });
  it("commits one analytics row when native ingestion and live telemetry race", async () => {
    const input = await batch(evidence(["one", "two"]));
    await Promise.all([
      live(),
      fixture.repository.nativeHistoryIngestion.ingest(LOCAL_USER_ID, input),
      fixture.repository.nativeHistoryIngestion.ingest(LOCAL_USER_ID, input),
    ]);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      outputTokens: 6,
      sourceAliases: ["gui-attempt"],
    });
  });
  it("does not acknowledge history before analytics persistence succeeds", async () => {
    const input = await batch(evidence(["one"]));
    await fixture.db.execute(
      sql`ALTER TABLE token_usage_records ADD CONSTRAINT fixture_usage_failure CHECK (false) NOT VALID`,
    );
    try {
      await expect(
        fixture.repository.nativeHistoryIngestion.ingest(LOCAL_USER_ID, input),
      ).rejects.toThrow();
      expect(
        await fixture.db.select().from(schema.nativeHistoryTurns),
      ).toHaveLength(0);
      expect(
        await fixture.db.select().from(schema.nativeHistoryReceipts),
      ).toHaveLength(0);
    } finally {
      await fixture.db.execute(
        sql`ALTER TABLE token_usage_records DROP CONSTRAINT fixture_usage_failure`,
      );
    }
    await fixture.repository.nativeHistoryIngestion.ingest(
      LOCAL_USER_ID,
      input,
    );
    expect((await rows())[0]).toMatchObject({ outputTokens: 3 });
  });
  it("keeps unknown timing and model attribution unknown while recovering measured tokens", async () => {
    const usage = evidence(["one"]);
    delete usage.modelAttribution;
    await ingest(usage, false);
    expect((await rows())[0]).toMatchObject({
      outputTokens: 3,
      modelId: null,
      startedAt: null,
      completedAt: null,
      finalizedAt: null,
    });
    expect(
      (
        await new TelemetryRepository(fixture.db).getAgentTimeAnalytics(
          LOCAL_USER_ID,
        )
      ).total.agentTimeMs,
    ).toBe(0);
  });
  it("keeps conflicting response evidence explicit and reports only the undisputed subtotal", async () => {
    await ingest(evidence(["one", "two"], false));
    const conflict = evidence(["one", "two"]);
    conflict.responses[0]!.usage = { ...counts, outputTokens: 99 };
    await ingest(conflict);
    expect((await rows())[0]).toMatchObject({
      outputTokens: 3,
      reportedTotalTokens: null,
      usageSemantics: "native-responses-partial-v1",
      nativeUsage: { conflictingResponseIds: ["one"], complete: false },
    });
  });
  it("continues recovering counters after the captured model route is removed", async () => {
    const original = capture;
    if (original.selection.status !== "resolved")
      throw new Error("Missing fixture selection");
    await fixture.db.insert(schema.modelRoutes).values({
      id: "removed-native-route",
      modelId: original.selection.modelId,
      providerId: original.selection.providerId,
      modelName: "retired",
      position: 90,
    });
    capture = {
      ...original,
      selection: { ...original.selection, routeId: "removed-native-route" },
    };
    try {
      await ingest(evidence(["one"]));
      await fixture.db
        .delete(schema.modelRoutes)
        .where(eq(schema.modelRoutes.id, "removed-native-route"));
      await ingest(evidence(["one", "two"]));
      expect((await rows())[0]).toMatchObject({
        outputTokens: 6,
        nativeModelAttribution: capture,
        modelId: original.selection.modelId,
      });
    } finally {
      capture = original;
    }
  });
});
