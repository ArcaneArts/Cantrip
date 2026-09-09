import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  nativeCommandReceiptSchema,
  type NativeSettingsState,
} from "@cantrip/protocol";
import { installInternalNativeCommandRoutes } from "../src/app/routes/internal-native-commands.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeAll(async () => {
  f = await createNativeSettingsFixture();
}, 60_000);
afterAll(async () => {
  await f?.close();
});

describe("committed native settings notifications", () => {
  it("invalidates accepted, dispatched and rejected settings without requiring a new native snapshot", async () => {
    const app = Fastify();
    const observed: Promise<NativeSettingsState | null>[] = [];
    const publish = vi.fn((chatId: string) => {
      observed.push(f.commands.settingsState(LOCAL_USER_ID, chatId));
    });
    installInternalNativeCommandRoutes(app, {
      config: f.config,
      serverId: "fixture-server",
      repository: f.repository,
      runAsOwner: async (_owner, execute) => execute(),
      dispatchNextQueuedPrompt: async () => {},
      live: {
        publishChatInvalidation: publish,
        publishChatSummary() {},
        publishChatTurnBoundary() {},
        publishEncryptedChatMessage() {},
        publishTaskMessage() {},
      },
    });
    const post = (phase: string, payload: object) =>
      app.inject({
        method: "POST",
        url: `/api/internal/native-commands/${phase}`,
        headers: { authorization: `Bearer ${f.config.workerToken}` },
        payload,
      });
    try {
      const input = await f.input();
      const admitted = await post("admit", input);
      expect(admitted.statusCode).toBe(200);
      const receipt = nativeCommandReceiptSchema.parse(admitted.json().receipt);
      expect((await observed.at(-1))?.desiredStatus).toBe("accepted");
      const dispatched = await post("dispatch", {
        workerId: f.workerId,
        operationId: input.operationId,
        operationGeneration: receipt.operationGeneration,
        session: input.session,
        payloadDigest: input.payloadDigest,
      });
      expect(dispatched.statusCode).toBe(200);
      expect((await observed.at(-1))?.desiredStatus).toBe("dispatched");
      const evidence = {
        workerId: f.workerId,
        operationId: input.operationId,
        operationGeneration: receipt.operationGeneration,
        eventId: randomUUID(),
        nativeOperationId: input.intent.nativeSettingsOperationId,
        threadId: input.session.threadId,
        runtimeGeneration: input.session.runtimeGeneration,
        kind: "rejected",
        submissionId: "fixture-submission",
        resultDigest: "b".repeat(64),
        protectedResult: settingsEnvelope,
      };
      // A failed persistence attempt must not broadcast a state that never committed.
      await f.client
        .exec(`CREATE FUNCTION fail_notification_state() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected settings write failure'; END $$;
        CREATE TRIGGER fail_notification_state BEFORE UPDATE ON native_settings_states
        FOR EACH ROW EXECUTE FUNCTION fail_notification_state()`);
      const beforeFailure = publish.mock.calls.length;
      try {
        expect((await post("settings-evidence", evidence)).statusCode).toBe(
          500,
        );
        expect(publish).toHaveBeenCalledTimes(beforeFailure);
      } finally {
        await f.client.exec(
          "DROP TRIGGER fail_notification_state ON native_settings_states",
        );
      }
      expect((await post("settings-evidence", evidence)).statusCode).toBe(200);
      expect((await observed.at(-1))?.desiredStatus).toBe("rejected");
      expect((await observed.at(-1))?.effective).toBeNull();
      const settled = await post("receipt", {
        workerId: f.workerId,
        operationId: input.operationId,
        operationGeneration: receipt.operationGeneration,
        status: "applied",
        protectedResult: null,
        resultDigest: null,
        rejectionCode: null,
        executionComplete: false,
      });
      expect(settled.statusCode).toBe(200);
      expect((await observed.at(-1))?.desiredStatus).toBe("rejected");
      expect(publish).toHaveBeenCalledTimes(4);
      expect(publish.mock.calls.every(([id]) => id === f.chatId)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
