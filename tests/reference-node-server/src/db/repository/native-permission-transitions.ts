import { isDeepStrictEqual } from "node:util";
import {
  DEFAULT_PERMISSION_PROFILE_ID,
  type NativeCommandAdmission,
  type NativeSettingsState,
  type PermissionTransition,
} from "@cantrip/protocol";
import type { ChatExecutionContext } from "./chat-execution-lanes.js";
import { NativeCommandError } from "./native-command-errors.js";

/** Resolves the requested choice from actual canonical policy, not the last
 * confirmed native selection. Default and forced Primary policy remain distinct. */
export function resolvePermissionTransition(
  context: ChatExecutionContext,
  selectedId: string | null,
  expectedRevision: string,
): PermissionTransition {
  const resolvedSelectedId =
    selectedId ??
    context.defaultPermissionProfileId ??
    DEFAULT_PERMISSION_PROFILE_ID;
  return {
    selectedId,
    resolvedSelectedId,
    effectiveId:
      context.isPrimary && context.worktreePolicy === "required-for-writes"
        ? ":read-only"
        : resolvedSelectedId,
    expectedRevision,
  };
}

/** Admission and dispatch both call this while holding the owning chat lock. */
export function assertPermissionTransition(
  context: ChatExecutionContext,
  state: NativeSettingsState,
  input: Pick<NativeCommandAdmission, "method" | "operationId" | "intent">,
): void {
  const transition = input.intent.permissionTransition;
  if (!transition) return;
  if (
    !state.binding ||
    input.intent.settingsBindingId !== state.binding.bindingId
  )
    throw new NativeCommandError(
      "permission-binding-required",
      "Read and publish the current native settings source before changing permissions.",
    );
  if (
    input.method !== "thread/settings/update" ||
    !input.intent.nativeSettingsOperationId ||
    !input.intent.settingKeys.includes("permissions")
  )
    throw new NativeCommandError("invalid-permission-transition");
  if (
    !isDeepStrictEqual(
      transition,
      resolvePermissionTransition(
        context,
        transition.selectedId,
        transition.expectedRevision,
      ),
    )
  )
    throw new NativeCommandError(
      "permission-policy-replaced",
      "The permission default or placement policy changed. Retry the choice.",
    );
  if (transition.expectedRevision !== (state.permissionPolicy?.revision ?? "0"))
    throw new NativeCommandError(
      "permission-revision-conflict",
      "The confirmed permission policy changed. Retry the choice.",
    );
  const pending = state.pending.some(
    (entry) =>
      entry.intent.permissionTransition &&
      entry.intent.operationId !== input.operationId,
  );
  const uncertain =
    state.desired?.permissionTransition &&
    state.desired.operationId !== input.operationId &&
    state.desiredStatus === "uncertain";
  if (pending || uncertain)
    throw new NativeCommandError(
      "permission-transition-pending",
      "Another permission change is still pending. Retry after it settles.",
    );
}
