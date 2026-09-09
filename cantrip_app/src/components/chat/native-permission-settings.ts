import type {
  NativeSettingsPatch,
  NativeThreadSettings,
} from "@cantrip/protocol";

export type NativePermissionSelection = {
  profileId: string | null;
  approvalPolicy: NativeThreadSettings["approvalPolicy"];
  approvalsReviewer: string;
  sandboxPolicy: NativeThreadSettings["sandboxPolicy"] | null;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function nativePermissionSelection(
  confirmed: NativeThreadSettings,
): NativePermissionSelection {
  return {
    profileId:
      object(confirmed.activePermissionProfile) &&
      typeof confirmed.activePermissionProfile.id === "string"
        ? confirmed.activePermissionProfile.id
        : null,
    approvalPolicy: confirmed.approvalPolicy,
    approvalsReviewer: confirmed.approvalsReviewer,
    sandboxPolicy: confirmed.sandboxPolicy,
  };
}

/** Public null is native omission for these security fields. Profile expansion
 * happens in native validation; never reuse an old sandbox as its new result. */
export function isNativePermissionPatch(patch: NativeSettingsPatch) {
  return (
    typeof patch.permissions === "string" ||
    patch.approvalPolicy != null ||
    patch.approvalsReviewer != null ||
    patch.sandboxPolicy != null
  );
}
export function requestedNativePermissions(
  confirmed: NativeThreadSettings,
  patches: readonly NativeSettingsPatch[],
) {
  const selected = nativePermissionSelection(confirmed);
  for (const patch of patches) {
    if (typeof patch.permissions === "string") {
      selected.profileId = patch.permissions;
      selected.sandboxPolicy = null;
    }
    if (patch.approvalPolicy != null)
      selected.approvalPolicy = patch.approvalPolicy;
    if (patch.approvalsReviewer != null)
      selected.approvalsReviewer = patch.approvalsReviewer;
    if (patch.sandboxPolicy != null) {
      selected.sandboxPolicy = patch.sandboxPolicy;
      // Explicit sandbox edits can depart from named profile provenance.
      if (typeof patch.permissions !== "string") selected.profileId = null;
    }
  }
  return selected;
}

/** The synthetic Cantrip YOLO preset is an exact profile + approval pairing.
 * Native custom security selections remain visible rather than being guessed. */
export function nativePermissionPreset(
  selection: NativePermissionSelection,
): string | null {
  const { profileId, approvalPolicy, sandboxPolicy } = selection;
  if (profileId === ":danger-full-access") {
    if (sandboxPolicy?.type !== "dangerFullAccess") return null;
    if (approvalPolicy === "never") return ":yolo";
    if (approvalPolicy !== "on-request") return null;
  }
  if (profileId === ":workspace" && sandboxPolicy?.type !== "workspaceWrite")
    return null;
  if (profileId === ":read-only" && sandboxPolicy?.type !== "readOnly")
    return null;
  return profileId;
}
