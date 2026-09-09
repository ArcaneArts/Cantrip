import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  NativeSettingsReadScope,
  ProtectedNativeSettingsSnapshot,
} from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import { installChatNativeSettingsRoutes } from "../src/app/routes/chat-native-settings.js";
import { readProtectedNativeSettings } from "../../cantrip_worker/src/native-settings-read.js";
import { openNativeSettingsSnapshot } from "../../cantrip_worker/src/native-settings-content.js";
import { nativeThreadSettings } from "../../cantrip_worker/test/fixtures/native-thread-settings.js";

let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});
const service = {
  ownerId: () => LOCAL_USER_ID,
  serverIdentity: () => "test-server",
  componentKey: () => ({ keyRevision: 1, key: Buffer.alloc(32, 8) }),
};
const current = () =>
  fixture.commands.settingsState(LOCAL_USER_ID, fixture.chatId);
function response(
  scope: NativeSettingsReadScope,
  revision = "1",
  generation = "runtime-one",
) {
  const runtime = {
    transportGeneration: generation,
    readNativeThreadSettings: async () => ({
      confirmed: {
        sequence: 1,
        operationId: null,
        submissionId: null,
        settings: nativeThreadSettings({
          settingsVersion: { epoch: "core", revision },
          privateInstructions: "not-for-server",
        }),
      },
      requests: [],
    }),
  };
  return readProtectedNativeSettings({
    scope,
    service,
    resolve: () => ({ scope, runtime, generation }),
  });
}

describe("shared settings native read and publication", () => {
  it("routes a fresh read to the owning worker and publishes only encrypted native settings", async () => {
    const app = Fastify();
    const request = vi.fn(async (_workerId, command) =>
      response(command.scope),
    );
    const publish = vi.fn();
    installChatNativeSettingsRoutes(app, {
      applicationOwnerId: () => LOCAL_USER_ID,
      publishChatInvalidation: publish,
      repository: { nativeCommands: fixture.commands },
      bridge: { request },
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: `/api/chats/${fixture.chatId}/native-settings/refresh`,
      });
      expect(result.statusCode).toBe(200);
      expect(publish).toHaveBeenCalledExactlyOnceWith(fixture.chatId, "chat");
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[0]).toBe(fixture.workerId);
      expect(result.body).not.toContain("not-for-server");
      const state = result.json();
      expect(state.binding).toMatchObject({
        workerId: fixture.workerId,
        nativeEpoch: "core",
        runtimeGeneration: "runtime-one",
      });
      expect(state.desired).toBeNull();
      const snapshot = state.effective as ProtectedNativeSettingsSnapshot;
      expect(
        (
          await openNativeSettingsSnapshot({
            service,
            context: snapshot.context,
            snapshot,
          })
        ).privateInstructions,
      ).toBe("not-for-server");
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/chats/${fixture.chatId}/native-settings`,
          })
        ).json(),
      ).toEqual(state);
    } finally {
      await app.close();
    }
  });

  it.each(["same", "replaced"])(
    "orders a late read against a %s native source",
    async (source) => {
      let release!: (snapshot: ProtectedNativeSettingsSnapshot) => void;
      let scope!: NativeSettingsReadScope;
      const older = fixture.commands.refreshSettingsState(
        LOCAL_USER_ID,
        fixture.chatId,
        (input) => {
          scope = input;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      );
      const outcome = older.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const newer = await fixture.commands.refreshSettingsState(
        LOCAL_USER_ID,
        fixture.chatId,
        (input) =>
          response(
            input,
            "9",
            source === "same" ? "runtime-one" : "runtime-replaced",
          ),
      );
      release(await response(scope, "2"));
      if (source === "replaced")
        expect(await outcome).toMatchObject({
          error: { code: "settings-read-replaced" },
        });
      else expect(await outcome).toEqual({ value: newer });
      expect(await current()).toEqual(newer);
    },
  );

  it("does not hold command admission behind a pending native read", async () => {
    let release!: (snapshot: ProtectedNativeSettingsSnapshot) => void;
    let scope!: NativeSettingsReadScope;
    const reading = fixture.commands.refreshSettingsState(
      LOCAL_USER_ID,
      fixture.chatId,
      (input) => {
        scope = input;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const input = await fixture.input("gui");
    const command = await fixture.commands.admit(LOCAL_USER_ID, input);
    expect(command.receipt.status).toBe("accepted");
    release(await response(scope, "10"));
    const result = await reading;
    expect(result.desired?.operationId).toBe(input.operationId);
    expect(result.desiredStatus).toBe("accepted");
    expect(result.effective?.context.settingsVersion.revision).toBe("10");
  });

  it("leaves the published state intact when a worker read fails or returns another source", async () => {
    const before = await current();
    await expect(
      fixture.commands.refreshSettingsState(
        LOCAL_USER_ID,
        fixture.chatId,
        async () => {
          throw new Error("Native transport disconnected");
        },
      ),
    ).rejects.toThrow("Native transport disconnected");
    await expect(
      fixture.commands.refreshSettingsState(
        LOCAL_USER_ID,
        fixture.chatId,
        (scope) => response({ ...scope, threadId: "another-thread" }),
      ),
    ).rejects.toMatchObject({ code: "settings-read-scope" });
    expect(await current()).toEqual(before);
    const read = vi.fn();
    await expect(
      fixture.commands.refreshSettingsState(
        "other-owner",
        fixture.chatId,
        read,
      ),
    ).rejects.toMatchObject({ code: "chat-not-found" });
    expect(read).not.toHaveBeenCalled();
    expect(
      await fixture.commands.settingsState("other-owner", fixture.chatId),
    ).toBeNull();
  });
});
