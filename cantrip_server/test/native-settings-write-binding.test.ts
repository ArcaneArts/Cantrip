import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import type {
  NativeCommandAdmission,
  NativeCommandReceipt,
} from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { installChatNativeSettingsRoutes } from "../src/app/routes/chat-native-settings.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
let revision = 0;
let source = 0;
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});
const state = () =>
  fixture.commands.settingsState(LOCAL_USER_ID, fixture.chatId);
async function bind(replaceSource = true) {
  if (replaceSource) source += 1;
  const result = await fixture.commands.refreshSettingsState(
    LOCAL_USER_ID,
    fixture.chatId,
    async (scope) => ({
      context: {
        chatId: scope.chatId,
        workerId: scope.workerId,
        threadId: scope.threadId,
        runtimeGeneration: "runtime-one",
        settingsVersion: {
          epoch: `core-${source}`,
          revision: String(++revision),
        },
      },
      contentFingerprint: "b".repeat(64),
      protectedContent: settingsEnvelope,
    }),
  );
  return result.binding!;
}
async function boundInput(bindingId: string) {
  const input = await fixture.input("gui");
  input.intent.settingsBindingId = bindingId;
  return input;
}
const dispatch = (
  input: NativeCommandAdmission,
  receipt: NativeCommandReceipt,
) =>
  fixture.commands.dispatch(LOCAL_USER_ID, {
    workerId: fixture.workerId,
    operationId: input.operationId,
    operationGeneration: receipt.operationGeneration,
    payloadDigest: input.payloadDigest,
    session: input.session,
  });

describe("native settings controller source binding", () => {
  it("routes the encrypted patch once without reading settings and retains queued status", async () => {
    const binding = await bind();
    const operation = {
      operationId: "http-settings-operation",
      bindingId: binding.bindingId,
      protectedPatch: settingsEnvelope,
    };
    const nativeReceipt = {
      operationId: operation.operationId,
      submissionId: "native-submission",
      status: "queued",
    };
    const request = vi.fn(async () => nativeReceipt);
    const publish = vi.fn();
    const app = Fastify();
    installChatNativeSettingsRoutes(app, {
      applicationOwnerId: () => LOCAL_USER_ID,
      repository: { nativeCommands: fixture.commands },
      bridge: { request },
      publishChatInvalidation: publish,
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: `/api/chats/${fixture.chatId}/native-settings/update`,
        payload: operation,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(nativeReceipt);
      expect(request).toHaveBeenCalledExactlyOnceWith(binding.workerId, {
        ...operation,
        type: "chat.settings.update",
        binding,
      });
      expect(publish).toHaveBeenCalledExactlyOnceWith(fixture.chatId, "chat");
      // The bridge fixture only provides routing evidence, not actual native application.
      expect((await state())?.desired?.operationId).not.toBe(
        operation.operationId,
      );
      request.mockClear();
      await bind();
      const stale = await app.inject({
        method: "POST",
        url: `/api/chats/${fixture.chatId}/native-settings/update`,
        payload: operation,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("settings-binding-replaced");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not report mismatched worker replies or invalid plaintext requests as successful", async () => {
    const binding = await bind();
    const request = vi.fn(async () => ({
      operationId: "another-operation",
      submissionId: null,
      status: "requesting",
    }));
    const publish = vi.fn();
    const app = Fastify();
    installChatNativeSettingsRoutes(app, {
      applicationOwnerId: () => LOCAL_USER_ID,
      repository: { nativeCommands: fixture.commands },
      bridge: { request },
      publishChatInvalidation: publish,
    });
    try {
      const payload = {
        operationId: "http-mismatched-reply",
        bindingId: binding.bindingId,
        protectedPatch: settingsEnvelope,
      };
      const invalid = await app.inject({
        method: "POST",
        url: `/api/chats/${fixture.chatId}/native-settings/update`,
        payload: { ...payload, patch: { model: "private-model" } },
      });
      expect(invalid.statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();
      const mismatch = await app.inject({
        method: "POST",
        url: `/api/chats/${fixture.chatId}/native-settings/update`,
        payload,
      });
      expect(mismatch.statusCode).toBe(500);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("resolves a current owner-scoped binding without changing canonical state", async () => {
    const binding = await bind();
    const before = await state();
    expect(
      await fixture.commands.resolveSettingsWriteBinding(
        LOCAL_USER_ID,
        fixture.chatId,
        binding.bindingId,
      ),
    ).toEqual(binding);
    await expect(
      fixture.commands.resolveSettingsWriteBinding(
        "another-owner",
        fixture.chatId,
        binding.bindingId,
      ),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it("keeps an admitted write valid when a refresh observes the same native source", async () => {
    const binding = await bind();
    const input = await boundInput(binding.bindingId);
    const { receipt } = await fixture.commands.admit(LOCAL_USER_ID, input);
    expect(receipt.status).toBe("accepted");
    expect(await bind(false)).toEqual(binding);
    await expect(dispatch(input, receipt)).resolves.toBeDefined();
    expect((await state())?.desired?.operationId).toBe(input.operationId);
    expect((await state())?.desiredStatus).toBe("dispatched");
  });

  it("refreshes the binding when encryption rotates at the same native revision", async () => {
    const binding = await bind();
    const before = await state();
    const rotated = await fixture.commands.refreshSettingsState(
      LOCAL_USER_ID,
      fixture.chatId,
      async () => ({
        ...before!.effective!,
        contentFingerprint: "c".repeat(64),
        protectedContent: {
          ...settingsEnvelope,
          keyRevision: settingsEnvelope.keyRevision + 1,
        },
      }),
    );
    expect(rotated.binding!.bindingId).not.toBe(binding.bindingId);
    expect(rotated.binding!.nativeEpoch).toBe(binding.nativeEpoch);
    expect(rotated.effective!.context.settingsVersion).toEqual(
      before!.effective!.context.settingsVersion,
    );
    expect(rotated.effective!.protectedContent.keyRevision).toBe(
      settingsEnvelope.keyRevision + 1,
    );
    await expect(
      fixture.commands.resolveSettingsWriteBinding(
        LOCAL_USER_ID,
        fixture.chatId,
        binding.bindingId,
      ),
    ).rejects.toMatchObject({ code: "settings-binding-replaced" });
  });

  it("rejects replaced bindings and mismatched runtime identities before admitting desired state", async () => {
    const old = await bind();
    const current = await bind();
    const before = await state();
    const stale = await boundInput(old.bindingId);
    const wrongRuntime = await boundInput(current.bindingId);
    wrongRuntime.session.runtimeGeneration = "another-runtime";
    for (const input of [stale, wrongRuntime]) {
      expect(
        (await fixture.commands.admit(LOCAL_USER_ID, input)).receipt,
      ).toMatchObject({
        status: "rejected",
        rejectionCode: "settings-binding-replaced",
      });
    }
    expect(await state()).toEqual(before);
  });

  it("rechecks binding under dispatch lock even when thread and runtime did not change", async () => {
    const binding = await bind();
    const input = await boundInput(binding.bindingId);
    const { receipt } = await fixture.commands.admit(LOCAL_USER_ID, input);
    expect(receipt.status).toBe("accepted");
    await bind();
    const before = await state();
    await expect(dispatch(input, receipt)).rejects.toMatchObject({
      code: "settings-binding-replaced",
    });
    expect(await state()).toEqual(before);
    expect(
      await fixture.commands.lookup(
        LOCAL_USER_ID,
        fixture.workerId,
        input.operationId,
      ),
    ).toMatchObject({ status: "accepted" });
    // Admission replay is historical evidence, never a renewed dispatch grant.
    expect(await fixture.commands.admit(LOCAL_USER_ID, input)).toMatchObject({
      replayed: true,
      receipt: { operationGeneration: receipt.operationGeneration },
    });
    expect(await state()).toEqual(before);
  });

  it("returns a completed historical receipt after binding replacement without restoring desired state", async () => {
    const binding = await bind();
    const input = await boundInput(binding.bindingId);
    const { receipt } = await fixture.commands.admit(LOCAL_USER_ID, input);
    await dispatch(input, receipt);
    await fixture.commands.settle(LOCAL_USER_ID, {
      workerId: fixture.workerId,
      operationId: input.operationId,
      operationGeneration: receipt.operationGeneration,
      status: "applied",
      protectedResult: null,
      resultDigest: null,
      rejectionCode: null,
      executionComplete: false,
    });
    const nextBinding = await bind();
    const next = await boundInput(nextBinding.bindingId);
    await fixture.commands.admit(LOCAL_USER_ID, next);
    const before = await state();
    expect(await fixture.commands.admit(LOCAL_USER_ID, input)).toMatchObject({
      replayed: true,
      receipt: { status: "applied", operationId: input.operationId },
    });
    expect(await state()).toEqual(before);
    await expect(
      fixture.commands.admit(LOCAL_USER_ID, {
        ...input,
        intent: { ...input.intent, settingsBindingId: nextBinding.bindingId },
      }),
    ).rejects.toMatchObject({ code: "operation-id-conflict" });
  });

  it("compares stored binding with canonical routing, not only its identifier", async () => {
    const binding = await bind();
    await fixture.db
      .update(schema.chatRuntimeSessions)
      .set({ codexThreadId: "replacement-thread" })
      .where(eq(schema.chatRuntimeSessions.chatId, fixture.chatId));
    try {
      await expect(
        fixture.commands.resolveSettingsWriteBinding(
          LOCAL_USER_ID,
          fixture.chatId,
          binding.bindingId,
        ),
      ).rejects.toMatchObject({ code: "settings-binding-replaced" });
    } finally {
      await fixture.db
        .update(schema.chatRuntimeSessions)
        .set({ codexThreadId: binding.threadId })
        .where(eq(schema.chatRuntimeSessions.chatId, fixture.chatId));
    }
  });

  it("keeps existing TUI settings supported and rejects binding metadata on unrelated commands", async () => {
    const terminal = await fixture.input("terminal");
    expect(
      (await fixture.commands.admit(LOCAL_USER_ID, terminal)).receipt.status,
    ).toBe("accepted");
    const binding = await bind();
    const unrelated = await boundInput(binding.bindingId);
    unrelated.method = "thread/name/set";
    delete unrelated.intent.nativeSettingsOperationId;
    expect(
      (await fixture.commands.admit(LOCAL_USER_ID, unrelated)).receipt,
    ).toMatchObject({
      status: "rejected",
      rejectionCode: "invalid-settings-binding-scope",
    });
  });
});
