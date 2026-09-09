import { isDeepStrictEqual } from "node:util";
import {
  clearSensitiveBytes,
  decryptNativeAccountDefaults,
  encryptNativeAccountDefaults,
} from "@cantrip/crypto";
import {
  nativeAccountDefaultsCommandSchema,
  nativeAccountDefaultsResponseSchema,
  type NativeAccountDefaultsCommand,
  type NativeAccountDefaultsWrite,
  type NativeSettingsReadScope,
} from "@cantrip/protocol";
import {
  CodexNativeRpcError,
  type CodexAppServer,
} from "./codex/app-server.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export async function protectedNativeAccountDefaults(input: {
  command: NativeAccountDefaultsCommand;
  service: Pick<
    WorkerEncryptionService,
    "componentKey" | "ownerId" | "serverIdentity"
  >;
  resolve():
    | {
        scope: NativeSettingsReadScope;
        generation: string;
        runtime: Pick<
          CodexAppServer,
          "transportGeneration" | "nativeAccountDefaults"
        >;
      }
    | undefined;
}) {
  const { binding, request } = nativeAccountDefaultsCommandSchema.parse(
    input.command,
  );
  const {
    bindingId,
    runtimeGeneration,
    nativeEpoch: _epoch,
    ...scope
  } = binding;
  if (request.bindingId !== bindingId)
    throw new Error("The account defaults binding changed.");
  const ownerId = input.service.ownerId();
  const serverId = input.service.serverIdentity();
  const target = input.resolve();
  const assertCurrent = () => {
    const current = input.resolve();
    if (
      !target ||
      !current ||
      current.runtime !== target.runtime ||
      current.generation !== runtimeGeneration ||
      target.generation !== runtimeGeneration ||
      target.runtime.transportGeneration !== runtimeGeneration ||
      !isDeepStrictEqual(scope, current.scope) ||
      input.service.ownerId() !== ownerId ||
      input.service.serverIdentity() !== serverId
    )
      throw new Error("The account defaults source was replaced.");
  };
  assertCurrent();
  const component = input.service.componentKey(
    "chat-content",
    request.action === "write" ? request.protectedWrite.keyRevision : undefined,
  );
  const context = {
    chatId: binding.chatId,
    bindingId,
    operationId: request.operationId,
  };
  try {
    let write: NativeAccountDefaultsWrite | undefined;
    if (request.action === "write")
      write = await decryptNativeAccountDefaults({
        ownerId,
        serverId,
        componentKey: component.key,
        keyRevision: component.keyRevision,
        context: { ...context, direction: "request" },
        envelope: request.protectedWrite,
      }).catch(() => {
        throw new Error(
          "The encrypted account defaults could not be opened. No write was requested.",
        );
      });
    assertCurrent();
    const value = await target!.runtime
      .nativeAccountDefaults({
        threadId: binding.threadId,
        settingsBindingId: bindingId,
        operationId: request.operationId,
        ...(write ? { write } : {}),
      })
      .catch((error) => {
        if (write && error instanceof CodexNativeRpcError)
          return {
            snapshot: null,
            write: null,
            verification: "rejected" as const,
          };
        // Never include decrypted config/errors in the server's public transport.
        throw new Error(
          "Account defaults did not return a confirmed result. Read current defaults before making another change.",
        );
      });
    assertCurrent();
    const protectedResult = await encryptNativeAccountDefaults({
      ownerId,
      serverId,
      componentKey: component.key,
      keyRevision: component.keyRevision,
      context: { ...context, direction: "response" },
      value,
    });
    assertCurrent();
    return nativeAccountDefaultsResponseSchema.parse({
      operationId: request.operationId,
      bindingId,
      protectedResult,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}
