import type { ChatPermissionProfileState } from "@cantrip/protocol";
import type { NativeSettingsController } from "./use-native-settings-controller";
import type { NativePermissionControlState } from "./permission-profile-control";
import { permissionProfileLabel } from "./permission-profile-control";
import {
  isNativePermissionPatch,
  nativePermissionPreset,
  nativePermissionSelection,
  requestedNativePermissions,
} from "./native-permission-settings";

export function nativePermissionControlState(
  session: NativeSettingsController,
  preference: ChatPermissionProfileState | undefined,
  error?: Error | null,
): NativePermissionControlState {
  const snapshot = session.binding ? session.observed.confirmed : null;
  const confirmed = snapshot ? nativePermissionSelection(snapshot) : null;
  const local = session.localPermission;
  const transition = preference?.transition;
  const nativeIntent = [...session.observed.intents]
    .reverse()
    .find((intent) => isNativePermissionPatch(intent.patch));
  let requestedLabel: string | null = null;
  let status: NativePermissionControlState["status"] = null;
  const sourceState = session.observed.state?.data;
  const matchingIntent = nativeIntent
    ? (sourceState?.pending.find(
        (entry) => entry.intent.operationId === nativeIntent.operationId,
      )?.intent ??
      (sourceState?.desired?.operationId === nativeIntent.operationId
        ? sourceState.desired
        : null))
    : null;
  const nativeChoice =
    nativeIntent && matchingIntent?.permissionTransition
      ? { ...matchingIntent.permissionTransition, status: nativeIntent.status }
      : null;
  const nativePendingIsNewer =
    nativeIntent?.pending &&
    nativeIntent.operationId !== transition?.operationId;
  const choice = local?.permissionSelection
    ? { selectedId: local.permissionSelection.id, status: local.status }
    : nativePendingIsNewer
      ? nativeChoice
      : (transition ?? nativeChoice);
  if (choice) {
    requestedLabel =
      choice.selectedId === null
        ? "Account default"
        : permissionProfileLabel(choice.selectedId);
    status =
      choice.status === "accepted" || choice.status === "dispatched"
        ? "queued"
        : choice.status;
  } else if (nativeIntent) {
    const pending = snapshot
      ? requestedNativePermissions(snapshot, session.pendingPatches)
      : null;
    requestedLabel = pending?.profileId
      ? permissionProfileLabel(pending.profileId)
      : "Custom native permissions";
    status =
      nativeIntent.pending && nativeIntent.status !== "rejected"
        ? "queued"
        : nativeIntent.status === "accepted" ||
            nativeIntent.status === "dispatched"
          ? "queued"
          : nativeIntent.status;
  }
  return {
    confirmed,
    confirmedPresetId: confirmed ? nativePermissionPreset(confirmed) : null,
    requestedLabel,
    status,
    disabled:
      !session.binding || session.observed.encryption.status !== "ready",
    error: error?.message ?? session.error?.message ?? null,
  };
}
