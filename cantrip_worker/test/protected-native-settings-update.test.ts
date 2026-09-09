import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  clearSensitiveBytes,
  deriveFieldKey,
  encryptNativeSettingsPatch,
  encryptPayload,
} from "@cantrip/crypto";
import {
  encryptionAssociatedDataSchema,
  type NativeSettingsPatch,
} from "@cantrip/protocol";
import {
  updateProtectedNativeSettings,
  type NativeSettingsUpdateTarget,
} from "../src/native-settings-update.js";

afterEach(() => vi.restoreAllMocks());

async function fixture(
  patch: NativeSettingsPatch = { model: "private-model" },
) {
  const scope = {
    chatId: "chat",
    workerId: "worker",
    threadId: "thread",
    contextKind: "project" as const,
    projectId: "project",
    placementId: "placement",
    modelRouteId: "route",
    providerAccountId: "account",
  };
  const binding = {
    ...scope,
    bindingId: "binding",
    runtimeGeneration: "runtime",
    nativeEpoch: "core",
  };
  let owner = "owner";
  let server = "server";
  const componentKey = vi.fn(() => ({
    keyRevision: 2,
    key: new Uint8Array(32).fill(6),
  }));
  const service = {
    ownerId: () => owner,
    serverIdentity: () => server,
    componentKey,
  };
  const runtime = {
    transportGeneration: "runtime",
    updateNativeThreadSettings: vi.fn<
      NativeSettingsUpdateTarget["runtime"]["updateNativeThreadSettings"]
    >(async (input) => ({
      operationId: input.operationId,
      submissionId: "native-submission",
      status: "queued",
      patch: input.patch,
      applied: null,
      error: { privateDetails: "must not leave the worker" },
    })),
  };
  let target: NativeSettingsUpdateTarget | undefined = {
    scope: { ...scope },
    runtime,
    generation: "runtime",
  };
  const resolve = vi.fn(() => target);
  const request = {
    operationId: "operation",
    bindingId: binding.bindingId,
    binding,
    protectedPatch: await encryptNativeSettingsPatch({
      ownerId: owner,
      serverId: server,
      componentKey: new Uint8Array(32).fill(6),
      keyRevision: 2,
      context: {
        chatId: scope.chatId,
        operationId: "operation",
        bindingId: binding.bindingId,
      },
      patch,
    }),
  };
  return {
    request,
    resolve,
    service,
    runtime,
    componentKey,
    get target() {
      return target;
    },
    set target(value) {
      target = value;
    },
    changeOwner() {
      owner = "other-owner";
    },
    changeServer() {
      server = "other-server";
    },
    run() {
      return updateProtectedNativeSettings({ request, resolve, service });
    },
    expectClearedKey() {
      expect(componentKey).toHaveBeenCalledWith("chat-content", 2);
      for (const result of componentKey.mock.results) {
        expect(result.value.key).toEqual(new Uint8Array(32));
      }
    },
  };
}

/** Keep real AES-GCM authentication but hold its completion so the owner can
 * change at the asynchronous boundary without timing-dependent sleeps. */
function holdDecryption() {
  const decrypt = globalThis.crypto.subtle.decrypt.bind(
    globalThis.crypto.subtle,
  );
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(globalThis.crypto.subtle, "decrypt").mockImplementation(
    async (...args) => {
      const plaintext = await decrypt(...args);
      started();
      await gate;
      return plaintext;
    },
  );
  return { entered, release };
}

describe("protected explicit native settings updates", () => {
  it.each<NativeSettingsPatch>([
    { model: "private-model" },
    { serviceTier: null, effort: "high" },
    { serviceTier: "fast" },
  ])(
    "passes exactly the authenticated patch and returns only a public receipt: %j",
    async (patch) => {
      const f = await fixture(patch);
      expect(await f.run()).toEqual({
        operationId: "operation",
        submissionId: "native-submission",
        status: "queued",
      });
      expect(
        f.runtime.updateNativeThreadSettings,
      ).toHaveBeenCalledExactlyOnceWith({
        threadId: "thread",
        operationId: "operation",
        settingsBindingId: "binding",
        nativeEpoch: "core",
        patch,
      });
      const sent = f.runtime.updateNativeThreadSettings.mock.calls[0]![0].patch;
      expect(Object.hasOwn(sent, "serviceTier")).toBe(
        Object.hasOwn(patch, "serviceTier"),
      );
      f.expectClearedKey();
    },
  );

  it.each(["binding", "operation", "owner"] as const)(
    "rejects a substituted %s before native input",
    async (field) => {
      const f = await fixture();
      if (field === "binding") {
        f.request.bindingId = "other-binding";
        f.request.binding.bindingId = "other-binding";
      } else if (field === "operation")
        f.request.operationId = "other-operation";
      else f.changeOwner();
      await expect(f.run()).rejects.toThrow();
      expect(f.runtime.updateNativeThreadSettings).not.toHaveBeenCalled();
      f.expectClearedKey();
    },
  );

  it("rejects an inconsistent request binding before opening its key", async () => {
    const f = await fixture();
    f.request.bindingId = "other-binding";
    await expect(f.run()).rejects.toThrow("another binding");
    expect(f.componentKey).not.toHaveBeenCalled();
    expect(f.runtime.updateNativeThreadSettings).not.toHaveBeenCalled();
  });

  it.each([
    "owner",
    "server",
    "runtime",
    "generation",
    "scope",
    "account",
    "missing",
  ] as const)(
    "rejects a changed %s while decryption is pending without native input",
    async (change) => {
      const f = await fixture();
      const crypto = holdDecryption();
      const pending = f.run();
      const rejected = expect(pending).rejects.toThrow(
        "current managed runtime",
      );
      await crypto.entered;
      if (change === "owner") f.changeOwner();
      else if (change === "server") f.changeServer();
      else if (change === "missing") f.target = undefined;
      else if (change === "runtime")
        f.target = { ...f.target!, runtime: { ...f.runtime } };
      else if (change === "generation")
        f.runtime.transportGeneration = "new-runtime";
      else
        f.target = {
          ...f.target!,
          scope: {
            ...f.target!.scope,
            ...(change === "account"
              ? { providerAccountId: "other-account" }
              : { placementId: "other-placement" }),
          },
        };
      crypto.release();
      await rejected;
      expect(f.runtime.updateNativeThreadSettings).not.toHaveBeenCalled();
      f.expectClearedKey();
    },
  );

  it("fails immediately for an absent runtime without preparing or polling one", async () => {
    const f = await fixture();
    f.target = undefined;
    await expect(f.run()).rejects.toThrow("current managed runtime");
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.componentKey).not.toHaveBeenCalled();
    expect(f.runtime.updateNativeThreadSettings).not.toHaveBeenCalled();
  });

  it("does not expose sensitive native failures or retry an uncertain dispatch", async () => {
    const f = await fixture();
    const error = new Error("Invalid private-model at /private/owner/config");
    f.runtime.updateNativeThreadSettings.mockRejectedValueOnce(error);
    const failure = await f.run().catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Native settings update did not return a confirmed receipt. Read its recorded state before submitting another change.",
    );
    expect(failure).not.toBe(error);
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain("private-model");
    expect(f.runtime.updateNativeThreadSettings).toHaveBeenCalledOnce();
    f.expectClearedKey();
  });

  it("does not expose authenticated invalid patch fields from schema errors", async () => {
    const f = await fixture();
    // Bypass only the sender's validating encoder. This is real, authenticated
    // ciphertext with invalid plaintext, not a mocked decryption exception.
    const associatedData = encryptionAssociatedDataSchema.parse({
      ownerId: "owner",
      component: "chat-content",
      table: "native-settings-update",
      field: "patch",
      rowId: createHash("sha256")
        .update(JSON.stringify(["server", "chat", "operation", "binding"]))
        .digest("hex"),
      formatVersion: 1,
      keyRevision: 2,
    });
    const key = deriveFieldKey({
      componentKey: new Uint8Array(32).fill(6),
      ownerId: "owner",
      component: associatedData.component,
      table: associatedData.table,
      field: associatedData.field,
      keyRevision: 2,
    });
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        "/private/owner/config": "private-model",
      }),
    );
    try {
      f.request.protectedPatch = await encryptPayload({
        key,
        plaintext,
        associatedData,
      });
    } finally {
      clearSensitiveBytes(key);
      clearSensitiveBytes(plaintext);
    }
    const failure = await f.run().catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "The encrypted settings patch could not be opened. No native update was requested.",
    );
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain("/private/owner/config");
    expect(f.runtime.updateNativeThreadSettings).not.toHaveBeenCalled();
    f.expectClearedKey();
  });

  it("does not publish a receipt when the runtime changes during native dispatch", async () => {
    const f = await fixture();
    f.runtime.updateNativeThreadSettings.mockImplementationOnce(
      async (input) => {
        f.runtime.transportGeneration = "new-runtime";
        return {
          operationId: input.operationId,
          submissionId: "native-submission",
          status: "applied",
          patch: input.patch,
          applied: null,
          error: null,
        };
      },
    );
    await expect(f.run()).rejects.toThrow("current managed runtime");
    expect(f.runtime.updateNativeThreadSettings).toHaveBeenCalledOnce();
    f.expectClearedKey();
  });
});
