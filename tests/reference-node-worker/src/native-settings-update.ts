import { isDeepStrictEqual } from "node:util";
import {
  clearSensitiveBytes,
  decryptNativeSettingsPatch,
} from "@cantrip/crypto";
import {
  nativeSettingsUpdateCommandSchema,
  nativeSettingsUpdateReceiptSchema,
  type NativeSettingsBinding,
  type NativeSettingsReadScope,
  type NativeSettingsUpdateRequest,
} from "@cantrip/protocol";
import type { CodexAppServer } from "./codex/app-server.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export interface NativeSettingsUpdateTarget {
  scope: NativeSettingsReadScope;
  runtime: Pick<
    CodexAppServer,
    "transportGeneration" | "updateNativeThreadSettings"
  >;
  generation: string;
}

/** Resolve the existing owner, decrypt the explicit patch and use the same
 * admitted native mutation path as TUI settings. Never bootstrap a new runtime. */
export async function updateProtectedNativeSettings(input: {
  request: NativeSettingsUpdateRequest & { binding: NativeSettingsBinding };
  resolve(): NativeSettingsUpdateTarget | undefined;
  service: Pick<
    WorkerEncryptionService,
    "componentKey" | "ownerId" | "serverIdentity"
  >;
}) {
  const request = nativeSettingsUpdateCommandSchema.parse({
    ...input.request,
    type: "chat.settings.update",
  });
  const {
    bindingId,
    runtimeGeneration,
    nativeEpoch: _epoch,
    ...scope
  } = request.binding;
  if (bindingId !== request.bindingId)
    throw new Error("The settings request belongs to another binding.");
  const target = input.resolve();
  const ownerId = input.service.ownerId();
  const serverId = input.service.serverIdentity();
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
      throw new Error(
        "The settings update no longer refers to the current managed runtime.",
      );
  };
  assertCurrent();
  const component = input.service.componentKey(
    "chat-content",
    request.protectedPatch.keyRevision,
  );
  try {
    const patch = await decryptNativeSettingsPatch({
      ownerId,
      serverId,
      componentKey: component.key,
      keyRevision: component.keyRevision,
      context: {
        chatId: scope.chatId,
        operationId: request.operationId,
        bindingId,
      },
      envelope: request.protectedPatch,
    }).catch(() => {
      // Native settings are private even when schema validation fails. Neither
      // the public error nor its cause may retain decrypted input.
      throw new Error(
        "The encrypted settings patch could not be opened. No native update was requested.",
      );
    });
    assertCurrent();
    const result = await target!.runtime
      .updateNativeThreadSettings({
        threadId: scope.threadId,
        operationId: request.operationId,
        settingsBindingId: bindingId,
        nativeEpoch: request.binding.nativeEpoch,
        patch,
      })
      .catch(() => {
        // The admitted mutation records protected error evidence. The transport
        // serializes this public message, so never forward native error details.
        throw new Error(
          "Native settings update did not return a confirmed receipt. Read its recorded state before submitting another change.",
        );
      });
    assertCurrent();
    return nativeSettingsUpdateReceiptSchema.parse({
      operationId: result.operationId,
      submissionId: result.submissionId,
      status: result.status,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}
