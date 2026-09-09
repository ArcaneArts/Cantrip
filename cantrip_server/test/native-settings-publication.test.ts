import Fastify from "fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import { installInternalNativeSettingsRoutes } from "../src/app/routes/internal-native-settings.js";
import { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.js";
import { NativeSettingsPublisher } from "../../cantrip_worker/src/native-settings-publisher.js";
import { NativeHistoryObservations } from "../../cantrip_worker/src/codex/native-history-observation.js";
import { readProtectedNativeSettings } from "../../cantrip_worker/src/native-settings-read.js";
import { protectNativeSettingsSnapshot } from "../../cantrip_worker/src/native-settings-content.js";
import { nativeThreadSettings } from "../../cantrip_worker/test/fixtures/native-thread-settings.js";

let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeAll(async () => {
  f = await createNativeSettingsFixture();
}, 60_000);
afterAll(async () => {
  await f?.close();
});
const service = {
  ownerId: () => LOCAL_USER_ID,
  serverIdentity: () => "fixture-server",
  componentKey: () => ({ keyRevision: 1, key: Buffer.alloc(32, 7) }),
};
const state = () => f.commands.settingsState(LOCAL_USER_ID, f.chatId);

describe("native settings observation boundaries", () => {
  it("delivers through authenticated HTTP, retries a lost acknowledgment and recovers after reconnect", async () => {
    const app = Fastify();
    const input = await f.input();
    const {
      runtimeGeneration: _generation,
      connectionId: _connection,
      ...session
    } = input.session;
    const scope = {
      ...session,
      threadId: input.session.threadId!,
      workerId: f.workerId,
    };
    let selected = nativeThreadSettings({
      settingsVersion: { epoch: "core", revision: "1" },
    });
    const observations = new NativeHistoryObservations();
    observations.replace("runtime-one");
    const runtime = {
      transportGeneration: "runtime-one",
      readNativeThreadSettings: vi.fn(async () => ({
        confirmed: {
          sequence: 1,
          operationId: null,
          submissionId: null,
          settings: selected,
        },
        requests: [],
      })),
      observeNativeHistory: (
        threadId: string,
        observer: Parameters<NativeHistoryObservations["subscribe"]>[1],
      ) =>
        observations.subscribe(threadId, observer, async () => {
          throw new Error("No history read");
        }),
    };
    const publish = vi.fn();
    installInternalNativeSettingsRoutes(app, {
      config: f.config,
      serverId: "fixture-server",
      repository: f.repository,
      runAsOwner: async (_owner, execute) => execute(),
      dispatchNextQueuedPrompt: async () => {},
      live: {
        publishChatInvalidation: publish,
        publishChatSummary() {},
        publishEncryptedChatMessage() {},
        publishTaskMessage() {},
        publishChatTurnBoundary() {},
      },
      bridge: {
        request: async (_worker, command) => {
          if (command.type !== "chat.settings.read")
            throw new Error("Unexpected worker input");
          return readProtectedNativeSettings({
            scope: command.scope,
            service,
            resolve: () => ({ scope, runtime, generation: "runtime-one" }),
          });
        },
      },
    });
    let lost = false;
    const bodies: string[] = [];
    const client = new NativeCommandClient({
      serverUrl: "http://fixture",
      workerId: f.workerId,
      token: () => f.config.workerToken,
      fetch: async (url, options) => {
        const response = await app.inject({
          method: "POST",
          url: new URL(String(url)).pathname,
          headers: options?.headers as Record<string, string>,
          payload: String(options?.body),
        });
        if (String(url).endsWith("settings-observation")) {
          bodies.push(String(options?.body));
          if (!lost && response.statusCode === 200) {
            lost = true;
            throw new Error("Lost HTTP acknowledgment after commit");
          }
        }
        return new Response(response.body, {
          status: response.statusCode,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const errors: unknown[] = [];
    const publisher = new NativeSettingsPublisher({
      scope,
      runtime,
      generation: "runtime-one",
      service,
      client,
      isCurrent: () => true,
      retryDelayMs: 10,
      onError: (error) => errors.push(error),
    });
    try {
      publisher.start();
      await vi.waitFor(async () =>
        expect(
          (await state())?.effective?.context.settingsVersion.revision,
        ).toBe("1"),
      );
      selected = nativeThreadSettings({
        settingsVersion: { epoch: "core", revision: "2" },
        privateInstructions: "secret-new-selection",
      });
      observations.notification("thread/settings/updated", {
        threadId: scope.threadId,
        threadSettings: selected,
      });
      await vi.waitFor(() => expect(bodies).toHaveLength(2));
      expect(bodies[0]).toBe(bodies[1]);
      expect(bodies[0]).not.toContain("secret-new-selection");
      const published = await state();
      expect(published?.effective?.context.settingsVersion.revision).toBe("2");
      expect(errors).toHaveLength(1);
      publisher.wake();
      await vi.waitFor(async () =>
        expect((await state())?.binding?.bindingId).not.toBe(
          published?.binding?.bindingId,
        ),
      );
      expect((await state())?.effective?.context.settingsVersion.revision).toBe(
        "2",
      );
      expect(publish).toHaveBeenCalled();
      const unauthorized = await app.inject({
        method: "POST",
        url: "/api/internal/native-commands/settings-refresh",
        payload: { workerId: f.workerId, chatId: f.chatId },
      });
      expect(unauthorized.statusCode).toBe(401);
    } finally {
      publisher.close();
      await app.close();
    }
  });

  it("rejects retired bindings and prevents another worker, thread or native epoch from publishing", async () => {
    const before = (await state())!;
    const value = {
      workerId: f.workerId,
      bindingId: before.binding!.bindingId,
      snapshot: before.effective!,
    };
    for (const changed of [
      { ...value, bindingId: "old-binding" },
      { ...value, workerId: "other-worker" },
      {
        ...value,
        snapshot: {
          ...value.snapshot,
          context: { ...value.snapshot.context, threadId: "other-thread" },
        },
      },
      {
        ...value,
        snapshot: {
          ...value.snapshot,
          context: {
            ...value.snapshot.context,
            settingsVersion: { epoch: "other-core", revision: "9" },
          },
        },
      },
    ])
      await expect(
        f.commands.observeSettingsState(LOCAL_USER_ID, changed),
      ).rejects.toMatchObject({ code: "settings-binding-replaced" });
    expect(await state()).toEqual(before);
    const stale = await protectNativeSettingsSnapshot({
      service,
      context: {
        ...before.effective!.context,
        settingsVersion: { epoch: "core", revision: "1" },
      },
      settings: nativeThreadSettings({
        settingsVersion: { epoch: "core", revision: "1" },
      }),
    });
    expect(
      (
        await f.commands.observeSettingsState(LOCAL_USER_ID, {
          ...value,
          snapshot: stale,
        })
      ).settingsVersion.revision,
    ).toBe("2");
    expect(await state()).toEqual(before);
  });

  it("rejects publication after the canonical route changes even if thread and runtime generation match", async () => {
    const before = (await state())!;
    const [route] = await f.db.select().from(schema.modelRoutes).limit(1);
    expect(route).toBeDefined();
    const where = and(
      eq(schema.chatRuntimeSessions.chatId, f.chatId),
      eq(schema.chatRuntimeSessions.workerId, f.workerId),
    );
    await f.db
      .update(schema.chatRuntimeSessions)
      .set({ modelRouteId: route!.id })
      .where(where);
    try {
      await expect(
        f.commands.observeSettingsState(LOCAL_USER_ID, {
          workerId: f.workerId,
          bindingId: before.binding!.bindingId,
          snapshot: before.effective!,
        }),
      ).rejects.toMatchObject({ code: "settings-binding-replaced" });
      expect(await state()).toEqual(before);
    } finally {
      await f.db
        .update(schema.chatRuntimeSessions)
        .set({ modelRouteId: before.binding!.modelRouteId })
        .where(where);
    }
  });
  it("does not acknowledge a settings observation if its durable write failed", async () => {
    const before = (await state())!;
    const version = {
      ...before.effective!.context.settingsVersion,
      revision: "3",
    };
    const snapshot = await protectNativeSettingsSnapshot({
      service,
      context: { ...before.effective!.context, settingsVersion: version },
      settings: nativeThreadSettings({ settingsVersion: version }),
    });
    const input = {
      workerId: f.workerId,
      bindingId: before.binding!.bindingId,
      snapshot,
    };
    await f.client
      .exec(`CREATE FUNCTION fail_observation_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected observation persistence failure'; END $$;
      CREATE TRIGGER fail_observation_write BEFORE UPDATE ON native_settings_states
      FOR EACH ROW EXECUTE FUNCTION fail_observation_write()`);
    try {
      await expect(
        f.commands.observeSettingsState(LOCAL_USER_ID, input),
      ).rejects.toThrow();
      expect(await state()).toEqual(before);
    } finally {
      await f.client.exec(
        "DROP TRIGGER fail_observation_write ON native_settings_states",
      );
    }
    expect(
      (await f.commands.observeSettingsState(LOCAL_USER_ID, input))
        .settingsVersion.revision,
    ).toBe("3");
    expect((await state())?.effective).toEqual(snapshot);
  });
});
