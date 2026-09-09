import { describe, expect, it, vi } from "vitest";
import {
  encryptNativeAccountDefaults,
  decryptNativeAccountDefaults,
} from "@cantrip/crypto";
import { protectedNativeAccountDefaults } from "../src/native-account-defaults.js";
import { CodexNativeRpcError } from "../src/codex/app-server.js";

async function fixture() {
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
  const crypto = {
    ownerId: "owner",
    serverId: "server",
    componentKey: new Uint8Array(32).fill(6),
    keyRevision: 2,
  };
  const context = { chatId: "chat", bindingId: "binding", operationId: "op" };
  const value = { expectedVersion: "v1", values: { model: "private-model" } };
  const protectedWrite = await encryptNativeAccountDefaults({
    ...crypto,
    context: { ...context, direction: "request" },
    value,
  });
  const result = {
    verification: "confirmed" as const,
    write: { status: "ok" as const, version: "v2" },
    snapshot: { version: "v2", stored: value.values, effective: value.values },
  };
  const runtime = {
    transportGeneration: "runtime",
    nativeAccountDefaults: vi.fn(async () => result),
  };
  const target = { scope, generation: "runtime", runtime };
  const componentKey = vi.fn(() => ({
    key: crypto.componentKey.slice(),
    keyRevision: 2,
  }));
  let owner = "owner";
  const input = {
    command: {
      type: "chat.account-defaults" as const,
      binding,
      request: {
        action: "write" as const,
        bindingId: "binding",
        operationId: "op",
        protectedWrite,
      },
    },
    service: {
      ownerId: () => owner,
      serverIdentity: () => "server",
      componentKey,
    },
    resolve: () => target,
  };
  return {
    crypto,
    context,
    input,
    target,
    runtime,
    result,
    componentKey,
    changeOwner: () => {
      owner = "other";
    },
  };
}
describe("protected account defaults", () => {
  it("authenticates the intent and returns only protected narrowed readback", async () => {
    const f = await fixture();
    const response = await protectedNativeAccountDefaults(f.input);
    expect(JSON.stringify(response)).not.toContain("private-model");
    expect(f.runtime.nativeAccountDefaults).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread",
      settingsBindingId: "binding",
      operationId: "op",
      write: { expectedVersion: "v1", values: { model: "private-model" } },
    });
    expect(
      await decryptNativeAccountDefaults({
        ...f.crypto,
        context: { ...f.context, direction: "response" },
        envelope: response.protectedResult,
      }),
    ).toEqual(f.result);
    for (const result of f.componentKey.mock.results)
      expect(result.value.key).toEqual(new Uint8Array(32));
    await expect(
      decryptNativeAccountDefaults({
        ...f.crypto,
        context: { ...f.context, direction: "request" },
        envelope: response.protectedResult,
      }),
    ).rejects.toThrow();
  });
  it("rejects a relabeled encrypted request before native input", async () => {
    const f = await fixture();
    f.input.command.request.operationId = "other-operation";
    await expect(protectedNativeAccountDefaults(f.input)).rejects.toThrow(
      "could not be opened",
    );
    expect(f.runtime.nativeAccountDefaults).not.toHaveBeenCalled();
  });
  it.each(["owner", "runtime", "route"])(
    "does not return a late %s result under another source",
    async (kind) => {
      const f = await fixture();
      f.runtime.nativeAccountDefaults.mockImplementation(async () => {
        if (kind === "owner") f.changeOwner();
        if (kind === "runtime") f.runtime.transportGeneration = "new-runtime";
        if (kind === "route")
          f.target.scope = { ...f.target.scope, modelRouteId: "new-route" };
        return f.result;
      });
      await expect(protectedNativeAccountDefaults(f.input)).rejects.toThrow(
        "source was replaced",
      );
    },
  );
  it("sanitizes native config error details", async () => {
    const f = await fixture();
    f.runtime.nativeAccountDefaults.mockRejectedValue(
      new Error("private instructions /private/account/config.toml"),
    );
    await expect(protectedNativeAccountDefaults(f.input)).rejects.toThrow(
      "did not return a confirmed result",
    );
  });
  it("distinguishes a native rejection from a lost write response without leaking its details", async () => {
    const f = await fixture();
    f.runtime.nativeAccountDefaults.mockRejectedValue(
      new CodexNativeRpcError("private error", {
        code: -32602,
        message: "private config rejected",
      }),
    );
    const response = await protectedNativeAccountDefaults(f.input);
    expect(
      await decryptNativeAccountDefaults({
        ...f.crypto,
        context: { ...f.context, direction: "response" },
        envelope: response.protectedResult,
      }),
    ).toEqual({ write: null, snapshot: null, verification: "rejected" });
  });
});
