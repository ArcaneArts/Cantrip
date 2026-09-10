import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { NativeRuntimeHandoffPrepared } from "@cantrip/protocol";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { installInternalNativeRuntimeHandoffRoutes } from "../src/app/routes/internal-native-runtime-handoffs.js";
import { NativeRuntimeHandoffClient } from "../../cantrip_worker/src/native-runtime-handoff-client.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
let bindingId: string;
const targetProvider = "handoff-provider-b";
const targetModel = "handoff-model-b";
const targetRoute = "handoff-route-b";
beforeEach(async () => {
  f = await createNativeSettingsFixture();
  // The base settings fixture deliberately leaves route selection unresolved.
  // A handoff starts from an already selected runtime, so bind its actual route
  // before obtaining the source settings binding.
  const [sourceRoute] = await f.db.select().from(schema.modelRoutes).limit(1);
  if (!sourceRoute) throw new Error("Missing fixture source route");
  await f.db
    .update(schema.chatRuntimeSessions)
    .set({ modelRouteId: sourceRoute.id })
    .where(eq(schema.chatRuntimeSessions.chatId, f.chatId));
  await f.db.insert(schema.modelProviders).values({
    id: targetProvider,
    ownerId: owner,
    name: "Provider B",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1/v1",
  });
  await f.db
    .insert(schema.modelProfiles)
    .values({ id: targetModel, ownerId: owner, name: "Model B" });
  await f.db.insert(schema.modelRoutes).values({
    id: targetRoute,
    modelId: targetModel,
    providerId: targetProvider,
    modelName: "fixture-b",
  });
  const state = await f.commands.refreshSettingsState(
    owner,
    f.chatId,
    async (scope) => ({
      context: {
        chatId: scope.chatId,
        threadId: scope.threadId,
        workerId: scope.workerId,
        runtimeGeneration: "runtime-one",
        settingsVersion: { epoch: "core-one", revision: "1" },
      },
      contentFingerprint: "a".repeat(64),
      protectedContent: settingsEnvelope,
    }),
  );
  bindingId = state.binding!.bindingId;
}, 60000);
afterEach(async () => {
  await f?.close();
});
const operations = () => f.repository.nativeRuntimeHandoffs;
const request = () => ({
  operationId: randomUUID(),
  bindingId,
  targetModelRouteId: targetRoute,
  targetProviderAccountId: null,
});
const begin = (input = request()) => operations().begin(owner, f.chatId, input);
function prepared(): NativeRuntimeHandoffPrepared {
  return {
    threadId: "native-thread",
    runtimeGeneration: "runtime-two",
    snapshot: {
      context: {
        chatId: f.chatId,
        workerId: f.workerId,
        threadId: "native-thread",
        runtimeGeneration: "runtime-two",
        settingsVersion: { epoch: "core-two", revision: "0" },
      },
      contentFingerprint: "b".repeat(64),
      protectedContent: settingsEnvelope,
      modelAttribution: {
        fingerprint: "c".repeat(64),
        selection: {
          status: "resolved",
          workerId: f.workerId,
          providerId: targetProvider,
          providerAccountId: null,
          modelId: targetModel,
          routeId: targetRoute,
        },
      },
    },
  };
}
async function markPrepared(id: string) {
  return operations().prepared(owner, f.workerId, id, prepared());
}
const context = () => f.repository.getChatExecutionContext(owner, f.chatId);

// Real migrated storage and the existing native admission/dispatch paths. These
// establish controller ownership, not a simulated claim of native file transfer.
describe("durable native provider handoff", () => {
  it("allows initial route resolution when native settings have no confirmed route yet", async () => {
    const state = (await f.commands.settingsState(owner, f.chatId))!;
    const prior = state.binding!;
    state.binding = { ...prior, modelRouteId: null };
    await f.db
      .update(schema.nativeSettingsStates)
      .set({ state })
      .where(eq(schema.nativeSettingsStates.chatId, f.chatId));
    await f.db
      .update(schema.chatRuntimeSessions)
      .set({ modelRouteId: null })
      .where(eq(schema.chatRuntimeSessions.chatId, f.chatId));
    await f.repository.updateChatRuntime(
      f.chatId,
      f.workerId,
      prior.placementId,
      prior.threadId,
      prior.modelRouteId!,
      "ready",
      prior.providerAccountId,
    );
    expect((await context())?.modelRouteId).toBe(prior.modelRouteId);
  });
  it("reserves one operation, rejects conflicting retries and both input origins, and survives restart", async () => {
    const input = request();
    const [a, b] = await Promise.all([begin(input), begin(input)]);
    expect(a).toEqual(b);
    expect(a.phase).toBe("preparing");
    await expect(
      begin({ ...input, targetModelRouteId: "different" }),
    ).rejects.toThrow("handoff-operation-conflict");
    await expect(begin()).rejects.toThrow("native-runtime-handoff-pending");
    for (const origin of ["gui", "terminal"] as const) {
      const denied = await f.commands.admit(owner, await f.input(origin));
      expect(denied.receipt).toMatchObject({
        status: "rejected",
        rejectionCode: "native-runtime-handoff-pending",
      });
    }
    await expect(
      f.repository.startChatExecutionLane(
        owner,
        f.chatId,
        "user",
        "racing input",
      ),
    ).rejects.toThrow("native-runtime-handoff-pending");
    await expect(
      f.repository.updateChatRuntime(
        f.chatId,
        f.workerId,
        a.source.placementId,
        "native-thread",
        targetRoute,
        "ready",
        null,
      ),
    ).rejects.toThrow("native-runtime-handoff-pending");
    await expect(
      f.repository.setChatModel(owner, f.chatId, {
        modelId: targetModel,
      }),
    ).rejects.toThrow("native-runtime-handoff-pending");
    await expect(
      f.repository.setChatReasoningEffort(owner, f.chatId, "high"),
    ).rejects.toThrow("native-runtime-handoff-pending");
    await expect(
      f.repository.setChatModelConfiguration(owner, f.chatId, {
        modelId: targetModel,
        reasoningEffort: null,
        customSubagentModel: false,
        subagentModelId: null,
        subagentReasoningEffort: null,
      }),
    ).rejects.toThrow("native-runtime-handoff-pending");
    await f.restart();
    expect(await operations().get(owner, f.chatId, a.operationId)).toEqual(a);
    expect(
      await operations().get("other-owner", f.chatId, a.operationId),
    ).toBeNull();
    await expect(
      operations().finish(owner, "other-worker", a.operationId, "cancelled"),
    ).rejects.toThrow("handoff-not-found");
    await operations().failure(
      owner,
      f.workerId,
      a.operationId,
      "destination-unavailable",
    );
    expect((await begin(input)).errorCode).toBe("destination-unavailable");
    await expect(begin()).rejects.toThrow("native-runtime-handoff-pending");
    await operations().finish(owner, f.workerId, a.operationId, "cancelled");
    expect((await begin()).phase).toBe("preparing");
  });
  it("commits route and protected settings atomically, keeps the native thread and custom child defaults", async () => {
    await f.db
      .update(schema.chats)
      .set({
        customSubagentModel: true,
        subagentModelId: targetModel,
        subagentReasoningEffort: "high",
      })
      .where(eq(schema.chats.id, f.chatId));
    const prior = await context();
    const input = request();
    const start = await begin(input);
    await markPrepared(start.operationId);
    expect((await context())?.modelRouteId).toBe(prior!.modelRouteId);
    const committed = await operations().commit(
      owner,
      f.workerId,
      start.operationId,
    );
    expect(committed.phase).toBe("committed");
    const changed = await context();
    expect(changed).toMatchObject({
      threadId: prior!.threadId,
      modelId: targetModel,
      modelRouteId: targetRoute,
      providerAccountId: null,
    });
    expect(changed!.modelConfiguration).toMatchObject({
      customSubagentModel: true,
      subagentModelId: targetModel,
      subagentReasoningEffort: "high",
    });
    expect(
      (await f.commands.settingsState(owner, f.chatId))?.binding,
    ).toMatchObject({
      runtimeGeneration: "runtime-two",
      modelRouteId: targetRoute,
      nativeEpoch: "core-two",
    });
    await expect(
      operations().finish(owner, f.workerId, start.operationId, "cancelled"),
    ).rejects.toThrow("handoff-phase-conflict");
    expect(
      (await f.commands.admit(owner, await f.input())).receipt.status,
    ).toBe("rejected");
    await f.restart();
    expect(
      await operations().commit(owner, f.workerId, start.operationId),
    ).toEqual(committed);
    const completed = await operations().finish(
      owner,
      f.workerId,
      start.operationId,
      "completed",
    );
    expect(await begin(input)).toEqual(completed);
    await expect(
      f.repository.updateChatRuntime(
        f.chatId,
        f.workerId,
        start.source.placementId,
        start.source.threadId,
        start.source.modelRouteId!,
        "ready",
        start.source.providerAccountId,
      ),
    ).rejects.toThrow("The native route changed");
    await f.repository.updateChatRuntime(
      f.chatId,
      f.workerId,
      start.source.placementId,
      start.source.threadId,
      targetRoute,
      "ready",
      null,
    );
    const retired = await f.commands.admit(owner, await f.input());
    expect(retired.receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "native-runtime-retired",
    });
    const current = await f.input();
    current.session.runtimeGeneration = "runtime-two";
    expect((await f.commands.admit(owner, current)).receipt.status).toBe(
      "accepted",
    );
  });
  it("rolls back a failed canonical commit and retries the same prepared operation", async () => {
    const before = await context();
    const settings = await f.commands.settingsState(owner, f.chatId);
    const job = await begin();
    await markPrepared(job.operationId);
    await f.client.exec(
      `CREATE FUNCTION reject_handoff_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture write failure'; END $$; CREATE TRIGGER reject_handoff_settings BEFORE UPDATE ON native_settings_states FOR EACH ROW EXECUTE FUNCTION reject_handoff_settings();`,
    );
    await expect(
      operations().commit(owner, f.workerId, job.operationId),
    ).rejects.toThrow();
    expect(await context()).toEqual(before);
    expect(await f.commands.settingsState(owner, f.chatId)).toEqual(settings);
    expect(
      (await operations().get(owner, f.chatId, job.operationId))?.phase,
    ).toBe("prepared");
    await f.client.exec(
      "DROP TRIGGER reject_handoff_settings ON native_settings_states; DROP FUNCTION reject_handoff_settings();",
    );
    expect(
      (await operations().commit(owner, f.workerId, job.operationId)).phase,
    ).toBe("committed");
  });
  it("requires matching destination evidence and never commits over a replaced source", async () => {
    const job = await begin();
    const wrong = prepared();
    wrong.runtimeGeneration = "runtime-one";
    await expect(
      operations().prepared(owner, f.workerId, job.operationId, wrong),
    ).rejects.toThrow("handoff-prepared-source-mismatch");
    const a = await markPrepared(job.operationId);
    expect(await markPrepared(job.operationId)).toEqual(a);
    const conflict = prepared();
    conflict.snapshot.contentFingerprint = "d".repeat(64);
    await expect(
      operations().prepared(owner, f.workerId, job.operationId, conflict),
    ).rejects.toThrow("handoff-preparation-conflict");
    await f.db
      .update(schema.chatRuntimeSessions)
      .set({ codexThreadId: "changed-native-thread" })
      .where(eq(schema.chatRuntimeSessions.chatId, f.chatId));
    await expect(
      operations().commit(owner, f.workerId, job.operationId),
    ).rejects.toThrow("handoff-source-replaced");
    expect((await context())?.threadId).toBe("changed-native-thread");
  });
  it("rejects pending admitted commands before reservation without hiding their result", async () => {
    const command = await f.input();
    const admitted = await f.commands.admit(owner, command);
    expect(admitted.receipt.status).toBe("accepted");
    await expect(begin()).rejects.toThrow("handoff-native-operation-pending");
    expect(
      (await f.commands.lookup(owner, f.workerId, command.operationId))?.status,
    ).toBe("accepted");
  });
  it("replaces a restarted destination by generation before commit and rejects late receipts", async () => {
    const job = await begin();
    await markPrepared(job.operationId);
    await f.restart();
    const recovered = prepared();
    recovered.runtimeGeneration = "runtime-three";
    recovered.snapshot.context.runtimeGeneration = "runtime-three";
    recovered.snapshot.context.settingsVersion.epoch = "core-three";
    await expect(
      operations().prepared(owner, f.workerId, job.operationId, recovered),
    ).rejects.toThrow("handoff-preparation-conflict");
    await operations().prepared(
      owner,
      f.workerId,
      job.operationId,
      recovered,
      "runtime-two",
    );
    await expect(markPrepared(job.operationId)).rejects.toThrow(
      "handoff-preparation-conflict",
    );
    await operations().commit(owner, f.workerId, job.operationId);
    expect(
      (await f.commands.settingsState(owner, f.chatId))?.binding
        ?.runtimeGeneration,
    ).toBe("runtime-three");
    await expect(
      operations().prepared(
        owner,
        f.workerId,
        job.operationId,
        prepared(),
        "runtime-three",
      ),
    ).rejects.toThrow("handoff-preparation-conflict");
  });
  it("uses authenticated worker HTTP receipts and recovers an uncertain commit without repeating preparation", async () => {
    const app = Fastify();
    const invalidations: string[] = [];
    installInternalNativeRuntimeHandoffRoutes(app, {
      repository: f.repository,
      config: f.config,
      runAsOwner: (_owner, run) => run(),
      live: {
        publishChatInvalidation: (id) => {
          invalidations.push(id);
        },
      },
    });
    try {
      const serverUrl = await app.listen({ port: 0, host: "127.0.0.1" });
      const job = await begin();
      let dropCommitResponse = true;
      const client = new NativeRuntimeHandoffClient({
        serverUrl,
        workerId: f.workerId,
        token: () => f.config.workerToken,
        fetch: async (url, options) => {
          const response = await fetch(url, options);
          if (
            JSON.parse(options!.body as string).action === "commit" &&
            dropCommitResponse
          ) {
            dropCommitResponse = false;
            await response.arrayBuffer();
            throw new Error("fixture lost committed response");
          }
          return response;
        },
      });
      const scope = { chatId: f.chatId, operationId: job.operationId };
      const read = () => client.request({ ...scope, action: "read" });
      expect(await read()).toEqual(job);
      await client.request({
        ...scope,
        action: "prepared",
        prepared: prepared(),
        expectedPreparedRuntimeGeneration: null,
      });
      await expect(
        client.request({ ...scope, action: "commit" }),
      ).rejects.toThrow("fixture lost committed response");
      expect((await read()).phase).toBe("committed");
      const committed = await client.request({ ...scope, action: "commit" });
      expect(committed.phase).toBe("committed");
      await client.request({
        ...scope,
        action: "finish",
        outcome: "completed",
      });
      expect((await read()).phase).toBe("completed");
      expect(invalidations.every((id) => id === f.chatId)).toBe(true);
      const rejected = await app.inject({
        method: "POST",
        url: "/api/internal/native-runtime-handoffs",
        headers: { authorization: "Bearer wrong-token" },
        payload: { ...scope, workerId: f.workerId, action: "read" },
      });
      expect(rejected.statusCode).toBe(401);
      const foreign = await app.inject({
        method: "POST",
        url: "/api/internal/native-runtime-handoffs",
        headers: { authorization: `Bearer ${f.config.workerToken}` },
        payload: { ...scope, workerId: "other-worker", action: "read" },
      });
      expect(foreign.statusCode).toBe(404);
      await expect(
        client.request({ ...scope, chatId: "other-chat", action: "read" }),
      ).rejects.toMatchObject({ code: "handoff-not-found" });
    } finally {
      await app.close();
    }
  });
  it("rejects stale bindings, foreign account selection and same-account model-only handoffs", async () => {
    await expect(
      begin({ ...request(), bindingId: "retired-binding" }),
    ).rejects.toThrow("handoff-source-replaced");
    await expect(
      begin({ ...request(), targetProviderAccountId: "foreign-account" }),
    ).rejects.toThrow("handoff-target-account-mismatch");
    const source = await context();
    await expect(
      begin({ ...request(), targetModelRouteId: source!.modelRouteId! }),
    ).rejects.toThrow("handoff-same-provider-account");
    expect((await begin()).phase).toBe("preparing");
  });
});
