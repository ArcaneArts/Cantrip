import { isDeepStrictEqual } from "node:util";
import {
  nativePermissionUpdateCommandSchema,
  nativeSettingsUpdateReceiptSchema,
  type NativePermissionUpdateCommand,
} from "@cantrip/protocol";
import { nativePermissionPatch } from "./codex/managed-native-permissions.js";
import type { NativeSettingsUpdateTarget } from "./native-settings-update.js";

/** The server resolves selection/default/worktree policy. Use only the existing
 * exact managed owner and the same durable admission as native TUI changes. */
export async function updateNativePermissions(input: {
  request: NativePermissionUpdateCommand;
  resolve(): NativeSettingsUpdateTarget | undefined;
}) {
  const request = nativePermissionUpdateCommandSchema.parse(input.request);
  const { bindingId, runtimeGeneration, nativeEpoch, ...scope } =
    request.binding;
  const target = input.resolve();
  const assertCurrent = () => {
    const current = input.resolve();
    if (
      !target ||
      !current ||
      current.runtime !== target.runtime ||
      current.generation !== runtimeGeneration ||
      target.generation !== runtimeGeneration ||
      current.runtime.transportGeneration !== runtimeGeneration ||
      !isDeepStrictEqual(scope, current.scope)
    )
      throw new Error(
        "The permission update no longer refers to the current managed runtime.",
      );
  };
  assertCurrent();
  const receipt = await target!.runtime.updateNativeThreadSettings({
    threadId: scope.threadId,
    operationId: request.operationId,
    settingsBindingId: bindingId,
    nativeEpoch,
    permissionTransition: request.permissionTransition,
    patch: {
      ...nativePermissionPatch(request.permissionTransition.effectiveId),
      applyAt: "quiescent",
    },
  });
  assertCurrent();
  return nativeSettingsUpdateReceiptSchema.parse({
    operationId: receipt.operationId,
    submissionId: receipt.submissionId,
    status: receipt.status,
  });
}
