import { createManagedChatPreparation } from "../src/app/runtime/managed-chat-preparation.js";
import {
  protectedChatFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import { installChatRuntimeHandoffRoutes } from "../src/app/routes/chat-runtime-handoffs.js";
import { runtimeHandoffConfiguration } from "../src/terminals/runtime-handoff-configuration.js";
import { resolveModelRoutePairs } from "../src/models/subagent-routing.js";
import { exerciseNativeHandoff } from "./native-handoff-executor-fixture.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
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
  it("discovers owned transfer routes and the durable latest operation without dispatching", async () => {
    const app = Fastify();
    let currentOwner = owner;
    const dispatched: unknown[] = [];
    installChatRuntimeHandoffRoutes(app, {
      applicationOwnerId: () => currentOwner,
      repository: f.repository,
      bridge: {
        request: async (_worker, command) => {
          dispatched.push(command);
        },
      },
      publishChatInvalidation() {},
    });
    try {
      const url = `/api/chats/${f.chatId}/runtime-handoffs`;
      let response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        chatId: f.chatId,
        binding: { bindingId },
        latest: null,
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: targetProvider,
            requiresAccount: false,
            accounts: [],
            models: [
              {
                routeId: targetRoute,
                name: "fixture-b",
                profileName: "Model B",
              },
            ],
          }),
        ]),
      });
      const created = await begin();
      response = await app.inject({ url });
      expect(response.json().latest).toEqual(created);
      await operations().requestCancellation(
        owner,
        f.chatId,
        created.operationId,
      );
      await operations().finish(
        owner,
        f.workerId,
        created.operationId,
        "cancelled",
      );
      expect((await app.inject({ url })).json().latest.phase).toBe("cancelled");
      await f.db
        .update(schema.modelRoutes)
        .set({ enabled: false })
        .where(eq(schema.modelRoutes.id, targetRoute));
      expect(
        (await app.inject({ url }))
          .json()
          .providers.some(
            (provider: { id: string }) => provider.id === targetProvider,
          ),
      ).toBe(false);
      currentOwner = "another-owner";
      expect((await app.inject({ url })).statusCode).toBe(404);
      expect(dispatched).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("lists enabled account choices without treating cached sign-in or quota state as a readiness gate", async () => {
    await f.db
      .update(schema.modelProviders)
      .set({ kind: "grok" })
      .where(eq(schema.modelProviders.id, targetProvider));
    for (const [index, enabled] of [true, false].entries()) {
      await f.db.insert(schema.modelProviderAccounts).values({
        id: `inventory-account-${index}`,
        providerId: targetProvider,
        position: index,
        protectedLabel: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: settingsEnvelope,
        },
        credentialHomeKey: `private-home-${index}`,
        credentialState: "signed-out",
        enabled,
        weeklyUsageUsedBasisPoints: 10000,
      });
    }
    const inventory = await operations().inventory(owner, f.chatId);
    const provider = inventory!.providers.find(
      (provider) => provider.id === targetProvider,
    )!;
    expect(provider.requiresAccount).toBe(true);
    expect(provider.accounts.map((account) => account.id)).toEqual([
      "inventory-account-0",
    ]);
    expect(provider.accounts[0]).not.toHaveProperty("credentialHomeKey");
    expect(provider.accounts[0]).not.toHaveProperty("protectedCredential");
  });
  it.skipIf(!process.env.CANTRIP_CODEX_TEST_BINARY)(
    "executes native transfer and recovers a cold destination after a lost canonical commit response",
    async () => {
      await exerciseNativeHandoff(f, targetRoute);
    },
    60000,
  );
  it.skipIf(!process.env.CANTRIP_CODEX_TEST_BINARY)(
    "retargets the attached native CLI through admitted publication, retries and return transfer",
    async () => {
      await exerciseNativeHandoff(f, targetRoute, true);
    },
    60000,
  );
  it("admits preserving views only on the canonical runtime during handoff", async () => {
    const job = await begin();
    const attachment = async (generation: string) => {
      const input = await f.input();
      input.method = "thread/resume";
      input.session.runtimeGeneration = generation;
      input.intent = { scope: "thread", settingKeys: [], expectedTurnId: null };
      return input;
    };
    const attach = async (generation: string) => {
      const input = await attachment(generation);
      const { receipt } = await f.commands.admit(owner, input);
      expect(receipt.status).toBe("accepted");
      await f.commands.dispatch(owner, {
        workerId: f.workerId,
        operationId: input.operationId,
        operationGeneration: receipt.operationGeneration,
        payloadDigest: input.payloadDigest,
        session: input.session,
      });
      await f.commands.settle(owner, {
        workerId: f.workerId,
        operationId: input.operationId,
        operationGeneration: receipt.operationGeneration,
        status: "applied",
        protectedResult: null,
        resultDigest: null,
        rejectionCode: null,
        executionComplete: false,
      });
    };
    await attach("runtime-one");
    await markPrepared(job.operationId);
    expect(
      (await f.commands.admit(owner, await attachment("runtime-two"))).receipt,
    ).toMatchObject({
      status: "rejected",
      rejectionCode: "native-runtime-handoff-pending",
    });
    expect(
      (await f.commands.admit(owner, await f.input())).receipt.status,
    ).toBe("rejected");
    await operations().commit(owner, f.workerId, job.operationId);
    await attach("runtime-two");
    expect(
      (await f.commands.admit(owner, await attachment("runtime-one"))).receipt
        .status,
    ).toBe("rejected");
    const mutation = await f.input();
    mutation.session.runtimeGeneration = "runtime-two";
    expect((await f.commands.admit(owner, mutation)).receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "native-runtime-handoff-pending",
    });
  });
  it("starts one durable worker operation, reads fresh exact configuration and retries without changing identity", async () => {
    const app = Fastify();
    let currentOwner = owner;
    const dispatched: unknown[] = [];
    let release!: () => void;
    let reject!: (error: Error) => void;
    const bridge = {
      request: async (_workerId: string, command: unknown) => {
        dispatched.push(command);
        return new Promise<void>((yes, no) => {
          release = yes;
          reject = no;
        });
      },
    };
    installChatRuntimeHandoffRoutes(app, {
      applicationOwnerId: () => currentOwner,
      repository: f.repository,
      bridge,
      publishChatInvalidation: () => {},
    });
    installInternalNativeRuntimeHandoffRoutes(app, {
      repository: f.repository,
      config: f.config,
      runAsOwner: (_owner, run) => run(),
      live: { publishChatInvalidation: () => {} },
      configuration: (ownerId, state, side) =>
        runtimeHandoffConfiguration(ownerId, state, side, {
          repository: f.repository,
          routePairsForConfiguration: async (_context, configuration, roots) =>
            resolveModelRoutePairs({
              configuration,
              rootRuntimes: roots ?? [],
            }),
        }),
    });
    try {
      const input = request();
      const created = await app.inject({
        method: "POST",
        url: `/api/chats/${f.chatId}/runtime-handoffs`,
        payload: input,
      });
      expect(created.statusCode, created.body).toBe(202);
      const state = created.json();
      expect(state.phase).toBe("preparing");
      expect(dispatched).toEqual([
        {
          type: "chat.runtime.handoff",
          intent: "continue",
          chatId: f.chatId,
          operationId: input.operationId,
        },
      ]);
      await app.inject({
        method: "POST",
        url: `/api/chats/${f.chatId}/runtime-handoffs`,
        payload: input,
      });
      expect(dispatched).toHaveLength(1);
      const statusUrl = `/api/chats/${f.chatId}/runtime-handoffs/${input.operationId}`;
      expect(
        (await app.inject({ method: "GET", url: statusUrl })).json().phase,
      ).toBe("preparing");
      expect(dispatched).toHaveLength(1);
      currentOwner = "other-owner";
      expect(
        (await app.inject({ method: "GET", url: statusUrl })).statusCode,
      ).toBe(404);
      currentOwner = owner;
      const serverUrl = await app.listen({ port: 0, host: "127.0.0.1" });
      const client = new NativeRuntimeHandoffClient({
        serverUrl,
        workerId: f.workerId,
        token: () => f.config.workerToken,
      });
      for (const side of ["source", "destination"] as const) {
        const response = await client.configuration({
          chatId: f.chatId,
          operationId: input.operationId,
          side,
        });
        expect(response.state.operationId).toBe(input.operationId);
        expect(response.configuration.model.routeId).toBe(
          side === "source" ? state.source.modelRouteId : targetRoute,
        );
        expect(response.configuration.session.chatId).toBe(f.chatId);
      }
      await expect(
        client.configuration({
          chatId: "other-chat",
          operationId: input.operationId,
          side: "destination",
        }),
      ).rejects.toMatchObject({ code: "handoff-not-found" });
      reject(new Error("fixture worker disconnected"));
      await expect
        .poll(
          async () =>
            (await operations().get(owner, f.chatId, input.operationId))
              ?.errorCode,
        )
        .toBe("handoff-worker-unavailable");
      expect(
        (await app.inject({ method: "POST", url: `${statusUrl}/retry` }))
          .statusCode,
      ).toBe(202);
      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]).toEqual(dispatched[0]);
      release();
      expect(
        (await operations().get(owner, f.chatId, input.operationId))?.phase,
      ).toBe("preparing");
    } finally {
      release?.();
      await app.close();
    }
  });
  it("dispatches durable cancellation while the original worker request is still pending", async () => {
    const app = Fastify();
    const commands: unknown[] = [];
    const pending: (() => void)[] = [];
    installChatRuntimeHandoffRoutes(app, {
      applicationOwnerId: () => owner,
      repository: f.repository,
      bridge: {
        request: async (_worker, command) => {
          commands.push(command);
          await new Promise<void>((resolve) => pending.push(resolve));
        },
      },
      publishChatInvalidation: () => {},
    });
    try {
      const input = request();
      await app.inject({
        method: "POST",
        url: `/api/chats/${f.chatId}/runtime-handoffs`,
        payload: input,
      });
      const url = `/api/chats/${f.chatId}/runtime-handoffs/${input.operationId}/cancel`;
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({
        phase: "preparing",
        cancelRequested: true,
      });
      expect(commands).toEqual([
        {
          type: "chat.runtime.handoff",
          chatId: f.chatId,
          operationId: input.operationId,
          intent: "continue",
        },
        {
          type: "chat.runtime.handoff",
          chatId: f.chatId,
          operationId: input.operationId,
          intent: "cancel",
        },
      ]);
      await app.inject({ method: "POST", url });
      expect(commands).toHaveLength(2);
      expect(
        (await operations().get(owner, f.chatId, input.operationId))
          ?.cancelRequested,
      ).toBe(true);
      await expect(markPrepared(input.operationId)).rejects.toThrow(
        "handoff-cancel-requested",
      );
      await expect(
        operations().commit(owner, f.workerId, input.operationId),
      ).rejects.toThrow("handoff-cancel-requested");
      expect(
        (await operations().get(owner, f.chatId, input.operationId))?.phase,
      ).toBe("preparing");
      await operations().finish(
        owner,
        f.workerId,
        input.operationId,
        "cancelled",
      );
      expect((await app.inject({ method: "POST", url })).json().phase).toBe(
        "cancelled",
      );
      expect(commands).toHaveLength(2);
      await f.restart();
      expect(
        (await operations().get(owner, f.chatId, input.operationId))
          ?.cancelRequested,
      ).toBe(true);
    } finally {
      pending.forEach((resolve) => resolve());
      await app.close();
    }
  });
  it("recovers the durable operation on reconnect even while an older dispatch is settling", async () => {
    const app = Fastify();
    const commands: unknown[] = [];
    const pending: (() => void)[] = [];
    const executor = installChatRuntimeHandoffRoutes(app, {
      applicationOwnerId: () => owner,
      repository: f.repository,
      bridge: {
        request: async (_worker, command) => {
          commands.push(command);
          await new Promise<void>((resolve) => pending.push(resolve));
        },
      },
      publishChatInvalidation: () => {},
    });
    try {
      const input = request();
      await app.inject({
        method: "POST",
        url: `/api/chats/${f.chatId}/runtime-handoffs`,
        payload: input,
      });
      await executor.workerConnected("other-owner", f.workerId);
      await executor.workerConnected(owner, "other-worker");
      expect(commands).toHaveLength(1);
      await executor.workerConnected(owner, f.workerId);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);
      pending[0]!();
      await new Promise((resolve) => setImmediate(resolve));
      const url = `/api/chats/${f.chatId}/runtime-handoffs/${input.operationId}`;
      await app.inject({ method: "POST", url: `${url}/retry` });
      expect(commands).toHaveLength(2);
      await operations().requestCancellation(
        owner,
        f.chatId,
        input.operationId,
      );
      await executor.workerConnected(owner, f.workerId);
      expect(commands).toHaveLength(3);
      expect(commands[2]).toMatchObject({
        operationId: input.operationId,
        intent: "cancel",
      });
      await operations().finish(
        owner,
        f.workerId,
        input.operationId,
        "cancelled",
      );
      await executor.workerConnected(owner, f.workerId);
      expect(commands).toHaveLength(3);
    } finally {
      pending.forEach((resolve) => resolve());
      await app.close();
    }
  });
  it("preserves a committed route when cancellation loses the transaction race", async () => {
    const state = await begin();
    await markPrepared(state.operationId);
    await operations().commit(owner, f.workerId, state.operationId);
    await expect(
      operations().requestCancellation(owner, f.chatId, state.operationId),
    ).rejects.toThrow("handoff-already-committed");
    expect((await context())?.modelRouteId).toBe(targetRoute);
    expect(
      (await operations().get(owner, f.chatId, state.operationId))
        ?.cancelRequested,
    ).toBe(false);
  });
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
  it.each([null, "high", undefined])(
    "commits the observed root effort %s without changing child defaults",
    async (effort) => {
      await f.db
        .update(schema.chats)
        .set({
          reasoningEffort: "low",
          customSubagentModel: true,
          subagentModelId: targetModel,
          subagentReasoningEffort: "medium",
        })
        .where(eq(schema.chats.id, f.chatId));
      const job = await begin();
      const value = prepared();
      if (effort !== undefined) value.reasoningEffort = effort;
      await operations().prepared(owner, f.workerId, job.operationId, value);
      await operations().commit(owner, f.workerId, job.operationId);
      expect((await context())!.modelConfiguration).toMatchObject({
        reasoningEffort: effort === undefined ? "low" : effort,
        customSubagentModel: true,
        subagentModelId: targetModel,
        subagentReasoningEffort: "medium",
      });
    },
  );
  it("enriches a legacy prepared receipt once and rejects conflicting effort for the same native read", async () => {
    const job = await begin();
    await markPrepared(job.operationId);
    const value = { ...prepared(), reasoningEffort: "high" };
    const enriched = await operations().prepared(
      owner,
      f.workerId,
      job.operationId,
      value,
    );
    expect(enriched.prepared?.reasoningEffort).toBe("high");
    await expect(
      operations().prepared(owner, f.workerId, job.operationId, {
        ...value,
        reasoningEffort: null,
      }),
    ).rejects.toThrow("handoff-preparation-conflict");
    await markPrepared(job.operationId);
    await operations().commit(owner, f.workerId, job.operationId);
    expect((await context())!.modelConfiguration.reasoningEffort).toBe("high");
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
  it("recovers the source without changing the reservation and keeps retired incarnations rejected after cancellation", async () => {
    const input = request();
    const job = await begin(input);
    const [route] = await f.db
      .select()
      .from(schema.modelRoutes)
      .where(eq(schema.modelRoutes.id, job.source.modelRouteId!));
    const selectedSourceRoute = randomUUID();
    await f.db.insert(schema.modelRoutes).values({
      id: selectedSourceRoute,
      modelId: targetModel,
      providerId: route!.providerId,
      modelName: "native-selected-model",
      position: 1,
    });
    const recovered = prepared();
    recovered.runtimeGeneration = "source-restarted";
    recovered.snapshot.context.runtimeGeneration = "source-restarted";
    recovered.snapshot.context.settingsVersion.epoch = "source-core-restarted";
    recovered.snapshot.modelAttribution!.selection = {
      status: "resolved",
      workerId: f.workerId,
      providerId: route!.providerId,
      modelId: targetModel,
      routeId: selectedSourceRoute,
      providerAccountId: job.source.providerAccountId,
    };
    const foreign = structuredClone(recovered);
    foreign.snapshot.modelAttribution!.selection =
      prepared().snapshot.modelAttribution!.selection;
    await expect(
      operations().recover(
        owner,
        f.workerId,
        job.operationId,
        "source",
        job.source.bindingId,
        foreign,
      ),
    ).rejects.toThrow("handoff-recovery-source-mismatch");
    await markPrepared(job.operationId);
    const restored = await operations().recover(
      owner,
      f.workerId,
      job.operationId,
      "source",
      job.source.bindingId,
      recovered,
    );
    expect(restored.phase).toBe("prepared");
    expect(restored.source).toEqual(job.source);
    expect(restored.binding!.runtimeGeneration).toBe("source-restarted");
    expect(
      (await f.commands.settingsState(owner, f.chatId))?.effective
        ?.modelAttribution?.selection,
    ).toMatchObject({ modelId: targetModel, routeId: selectedSourceRoute });
    expect((await context())?.modelRouteId).toBe(job.source.modelRouteId);
    await f.restart();
    expect(await begin(input)).toEqual(restored);
    expect(
      await operations().recover(
        owner,
        f.workerId,
        job.operationId,
        "source",
        job.source.bindingId,
        recovered,
      ),
    ).toEqual(restored);
    const stale = structuredClone(recovered);
    stale.runtimeGeneration = "source-late";
    stale.snapshot.context.runtimeGeneration = "source-late";
    await expect(
      operations().recover(
        owner,
        f.workerId,
        job.operationId,
        "source",
        job.source.bindingId,
        stale,
      ),
    ).rejects.toThrow("handoff-recovery-conflict");
    const retired = structuredClone(recovered);
    retired.runtimeGeneration = job.source.runtimeGeneration;
    retired.snapshot.context.runtimeGeneration = job.source.runtimeGeneration;
    await expect(
      operations().recover(
        owner,
        f.workerId,
        job.operationId,
        "source",
        restored.binding!.bindingId,
        retired,
      ),
    ).rejects.toThrow("handoff-recovery-source-mismatch");
    await expect(
      operations().recover(
        owner,
        f.workerId,
        job.operationId,
        "destination",
        restored.binding!.bindingId,
        prepared(),
      ),
    ).rejects.toThrow("handoff-phase-conflict");
    await operations().finish(owner, f.workerId, job.operationId, "cancelled");
    expect(
      (await f.commands.admit(owner, await f.input())).receipt,
    ).toMatchObject({
      status: "rejected",
      rejectionCode: "native-runtime-retired",
    });
    const abandonedDestination = await f.input();
    abandonedDestination.session.runtimeGeneration = "runtime-two";
    expect(
      (await f.commands.admit(owner, abandonedDestination)).receipt,
    ).toMatchObject({
      status: "rejected",
      rejectionCode: "native-runtime-retired",
    });
    const fresh = await f.input();
    fresh.session.runtimeGeneration = "source-restarted";
    expect((await f.commands.admit(owner, fresh)).receipt.status).toBe(
      "accepted",
    );
  });
  it("replaces destination Core epochs without retiring their live transport and rejects stale epoch publication", async () => {
    const job = await begin();
    const original = prepared();
    await markPrepared(job.operationId);
    const reloaded = structuredClone(original);
    reloaded.snapshot.context.settingsVersion.epoch = "core-reloaded";
    await expect(
      operations().prepared(
        owner,
        f.workerId,
        job.operationId,
        reloaded,
        original.runtimeGeneration,
      ),
    ).rejects.toThrow("handoff-preparation-conflict");
    const next = await operations().prepared(
      owner,
      f.workerId,
      job.operationId,
      reloaded,
      original.runtimeGeneration,
      "core-two",
    );
    expect(next.retiredRuntimeGenerations).not.toContain(
      original.runtimeGeneration,
    );
    expect(next.retiredNativeEpochs).toContainEqual({
      runtimeGeneration: original.runtimeGeneration,
      nativeEpoch: "core-two",
    });
    await expect(
      operations().prepared(
        owner,
        f.workerId,
        job.operationId,
        original,
        original.runtimeGeneration,
        "core-reloaded",
      ),
    ).rejects.toThrow("handoff-prepared-source-mismatch");
    const committed = await operations().commit(
      owner,
      f.workerId,
      job.operationId,
    );
    const latest = structuredClone(reloaded);
    latest.snapshot.context.settingsVersion.epoch = "core-latest";
    const recovered = await operations().recover(
      owner,
      f.workerId,
      job.operationId,
      "destination",
      committed.binding!.bindingId,
      latest,
    );
    expect(recovered.retiredRuntimeGenerations).not.toContain(
      original.runtimeGeneration,
    );
    await expect(
      operations().recover(
        owner,
        f.workerId,
        job.operationId,
        "destination",
        recovered.binding!.bindingId,
        reloaded,
      ),
    ).rejects.toThrow("handoff-recovery-source-mismatch");
    await operations().finish(owner, f.workerId, job.operationId, "completed");
    await expect(
      f.commands.refreshSettingsState(
        owner,
        f.chatId,
        async () => reloaded.snapshot,
      ),
    ).rejects.toThrow("native-runtime-retired");
    await expect(
      f.commands.observeSettingsState(owner, {
        workerId: f.workerId,
        bindingId: recovered.binding!.bindingId,
        snapshot: original.snapshot,
      }),
    ).rejects.toThrow("native-runtime-retired");
    const fresh = await f.commands.refreshSettingsState(
      owner,
      f.chatId,
      async () => latest.snapshot,
    );
    expect(fresh.binding!.runtimeGeneration).toBe(original.runtimeGeneration);
    expect(fresh.binding!.nativeEpoch).toBe("core-latest");
  });
  it("keeps ordinary settings refreshes from replacing a reserved handoff binding", async () => {
    const prior = (await f.commands.settingsState(owner, f.chatId))!;
    await begin();
    let reads = 0;
    await expect(
      f.commands.refreshSettingsState(owner, f.chatId, async () => {
        reads++;
        return prior.effective!;
      }),
    ).rejects.toThrow("native-runtime-handoff-pending");
    expect(reads).toBe(1);
    expect(await f.commands.settingsState(owner, f.chatId)).toEqual(prior);
    await expect(
      f.commands.observeSettingsState(owner, {
        workerId: f.workerId,
        bindingId: prior.binding!.bindingId,
        snapshot: prior.effective!,
      }),
    ).rejects.toThrow("native-runtime-handoff-pending");
  });
  it("recovers a committed destination atomically without reopening source routing", async () => {
    const job = await begin();
    await markPrepared(job.operationId);
    const committed = await operations().commit(
      owner,
      f.workerId,
      job.operationId,
    );
    const before = await f.commands.settingsState(owner, f.chatId);
    const recovered = prepared();
    recovered.runtimeGeneration = "destination-restarted";
    recovered.snapshot.context.runtimeGeneration = "destination-restarted";
    recovered.snapshot.context.settingsVersion.epoch =
      "destination-core-restarted";
    const recover = () =>
      operations().recover(
        owner,
        f.workerId,
        job.operationId,
        "destination",
        committed.binding!.bindingId,
        recovered,
      );
    await f.client.exec(
      `CREATE FUNCTION reject_handoff_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture recovery failure'; END $$; CREATE TRIGGER reject_handoff_recovery BEFORE UPDATE ON native_runtime_handoffs FOR EACH ROW EXECUTE FUNCTION reject_handoff_recovery();`,
    );
    await expect(recover()).rejects.toThrow();
    expect(await f.commands.settingsState(owner, f.chatId)).toEqual(before);
    expect(await operations().get(owner, f.chatId, job.operationId)).toEqual(
      committed,
    );
    await f.client.exec(
      "DROP TRIGGER reject_handoff_recovery ON native_runtime_handoffs; DROP FUNCTION reject_handoff_recovery();",
    );
    await f.restart();
    const restored = await recover();
    expect(restored.phase).toBe("committed");
    expect(restored.prepared).toEqual(recovered);
    expect(restored.retiredRuntimeGenerations).toEqual([
      "runtime-one",
      "runtime-two",
    ]);
    expect((await context())?.modelRouteId).toBe(targetRoute);
    expect(await recover()).toEqual(restored);
    await expect(
      operations().recover(
        owner,
        f.workerId,
        job.operationId,
        "source",
        restored.binding!.bindingId,
        recovered,
      ),
    ).rejects.toThrow("handoff-phase-conflict");
    await expect(
      operations().recover(
        owner,
        "foreign-worker",
        job.operationId,
        "destination",
        restored.binding!.bindingId,
        recovered,
      ),
    ).rejects.toThrow("handoff-not-found");
    await operations().finish(owner, f.workerId, job.operationId, "completed");
    const old = await f.input();
    old.session.runtimeGeneration = "runtime-two";
    expect((await f.commands.admit(owner, old)).receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "native-runtime-retired",
    });
    const fresh = await f.input();
    fresh.session.runtimeGeneration = "destination-restarted";
    expect((await f.commands.admit(owner, fresh)).receipt.status).toBe(
      "accepted",
    );
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
      const recovered = prepared();
      recovered.runtimeGeneration = "http-restarted";
      recovered.snapshot.context.runtimeGeneration = "http-restarted";
      recovered.snapshot.context.settingsVersion.epoch = "http-core-restarted";
      const restored = await client.request({
        ...scope,
        action: "recover",
        side: "destination",
        expectedBindingId: committed.binding!.bindingId,
        recovered,
      });
      expect(restored.binding!.runtimeGeneration).toBe("http-restarted");
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

it.each(["completed", "cancelled"] as const)(
  "waits for %s reconnect recovery per chat before preparing its CLI",
  async (outcome) => {
    const app = Fastify();
    const original = (await context())!;
    const other = (await f.repository.createChat(owner, original.projectId!, {
      ...protectedChatFields(),
      worktreeId: original.worktreeId,
    }))!;
    await f.repository.managedChatPreparations.request(
      owner,
      f.chatId,
      f.workerId,
    );
    await f.repository.managedChatPreparations.request(
      owner,
      other.id,
      f.workerId,
    );
    const job = await begin();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ensured: { chatId: string; routeId: string | undefined }[] = [];
    const attachments = new Map<string, () => void>();
    const bridge: Pick<WorkerCommandBus, "request"> = {
      request: async (_worker, command, options) => {
        if (command.type === "chat.runtime.handoff") {
          await waiting;
          if (outcome === "completed") {
            await markPrepared(job.operationId);
            await operations().commit(owner, f.workerId, job.operationId);
          } else
            await operations().requestCancellation(
              owner,
              f.chatId,
              job.operationId,
            );
          await operations().finish(
            owner,
            f.workerId,
            job.operationId,
            outcome,
          );
          return { status: outcome };
        }
        if (command.type === "chat.thread.ensure") {
          ensured.push({
            chatId: command.session!.chatId,
            routeId: command.model.routeId,
          });
          return {
            threadId: command.threadId ?? `native-${command.session!.chatId}`,
          };
        }
        if (command.type === "terminal.prepare-state")
          return protectedTerminalFields(command.terminalId);
        if (command.type === "terminal.open") {
          const finished = new Promise((resolve) =>
            attachments.set(command.attachmentId, () =>
              resolve({ status: "detached" }),
            ),
          );
          options?.onEvent?.({ type: "terminal.ready" } as never);
          return finished;
        }
        if (command.type === "terminal.detach") {
          attachments.get(command.attachmentId)?.();
          return { status: "detached" };
        }
        throw new Error(`Unexpected worker command ${command.type}`);
      },
    };
    const recovery = installChatRuntimeHandoffRoutes(app, {
      applicationOwnerId: () => owner,
      repository: f.repository,
      bridge,
      publishChatInvalidation() {},
    });
    const preparation = createManagedChatPreparation({
      repository: f.repository,
      bridge,
      serverId: "server",
      runAsOwner: async (_owner, run) => run(),
      publish() {},
      runtimeForContext: async () =>
        (await f.repository.getModelRuntimeByRoute(
          owner,
          original.modelRouteId!,
        ))!,
      routePairsForConfiguration: async (
        _context,
        _configuration,
        runtimes,
      ) => [
        {
          root: { runtime: runtimes[0]!, reasoningEffort: null },
          subagent: null,
        },
      ],
    });
    let barriers:
      Awaited<ReturnType<typeof recovery.workerConnected>> | undefined;
    try {
      barriers = await recovery.workerConnected(owner, f.workerId);
      await preparation.workerConnected(owner, f.workerId, barriers);
      await preparation.settle(owner, other.id);
      expect(
        (await f.repository.managedChatPreparations.get(owner, other.id))
          ?.phase,
      ).toBe("ready");
      expect(ensured.filter((call) => call.chatId === f.chatId)).toEqual([]);
      let joined = false;
      const join = preparation.join(owner, f.chatId).then(() => {
        joined = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(joined).toBe(false);
      release();
      await join;
      await preparation.settle(owner, f.chatId);
      expect(ensured.filter((call) => call.chatId === f.chatId)).toEqual([
        {
          chatId: f.chatId,
          routeId:
            outcome === "completed" ? targetRoute : original.modelRouteId,
        },
      ]);
      expect(
        (await f.repository.managedChatPreparations.get(owner, f.chatId))
          ?.phase,
      ).toBe("ready");
    } finally {
      release();
      if (barriers instanceof Map) await Promise.allSettled(barriers.values());
      await preparation.settle(owner, f.chatId);
      await preparation.settle(owner, other.id);
      await vi.waitFor(async () =>
        expect(
          (await operations().get(owner, f.chatId, job.operationId))?.phase,
        ).toBe(outcome),
      );
      await app.close();
    }
  },
  60000,
);
