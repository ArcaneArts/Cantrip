import { isDeepStrictEqual } from "node:util";
import {
  YOLO_PERMISSION_PROFILE_ID,
  type NativePermissionPolicyClaim,
  type NativeThreadSettings,
  type PermissionTransition,
} from "@cantrip/protocol";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const nativePermissionKeys = [
  "approvalPolicy",
  "approvalsReviewer",
  "sandbox",
  "sandboxPolicy",
  "permissions",
  "permissionProfile",
  "permissionProfileId",
] as const;

export function hasNativePermissionUpdate(
  params: Record<string, unknown>,
): boolean {
  return nativePermissionKeys.some((key) => params[key] != null);
}

/** Managed presets have one explicit selector and approval pairing. Do not
 * guess a profile from a sandbox name or discard custom security fields. */
export function requestedNativePermissionProfile(
  params: Record<string, unknown>,
  current: Readonly<Record<string, unknown>>,
): string {
  for (const key of [
    "sandbox",
    "sandboxPolicy",
    "permissionProfile",
    "permissionProfileId",
  ])
    if (params[key] != null)
      throw new Error(
        "Custom native security overrides cannot be represented by a managed permission profile. Select a named profile through /permissions.",
      );
  const permissions = params.permissions ?? current.permissions;
  const approval = params.approvalPolicy ?? current.approvalPolicy;
  const reviewer =
    params.approvalsReviewer ?? current.approvalsReviewer ?? "user";
  if (typeof permissions !== "string" || !permissions || reviewer !== "user")
    throw new Error(
      "This native security selection cannot be represented by a managed permission profile.",
    );
  if (permissions === ":danger-full-access" && approval === "never")
    return YOLO_PERMISSION_PROFILE_ID;
  if (approval !== "on-request")
    throw new Error(
      "This approval policy does not match the selected managed permission profile.",
    );
  return permissions;
}

export function nativePermissionPatch(
  profileId: string,
): Record<string, unknown> {
  return {
    permissions:
      profileId === YOLO_PERMISSION_PROFILE_ID
        ? ":danger-full-access"
        : profileId,
    approvalPolicy:
      profileId === YOLO_PERMISSION_PROFILE_ID ? "never" : "on-request",
    approvalsReviewer: "user",
  };
}

/** Normalize only after authoritative profile resolution; the caller encrypts
 * and admits this exact frame. Private metadata never becomes a native field. */
export function applyNativePermissionTransition(
  params: Record<string, unknown>,
  transition: PermissionTransition,
): Record<string, unknown> {
  const next = { ...params };
  for (const key of nativePermissionKeys) delete next[key];
  return {
    ...next,
    ...nativePermissionPatch(transition.effectiveId),
    applyAt: "quiescent",
  };
}

/** Native resolves this tuple with the same configuration operation that was
 * persisted at admission. Compare every security field, not just its label. */
export function confirmedNativePermissionClaim(input: {
  transition: PermissionTransition;
  settings: NativeThreadSettings;
  resolvedSecurity: unknown;
}): NativePermissionPolicyClaim {
  const { settings, transition, resolvedSecurity } = input;
  if (!settings.settingsVersion || !object(resolvedSecurity))
    throw new Error(
      "Native permission application lacks versioned security resolution.",
    );
  for (const key of [
    "approvalPolicy",
    "approvalsReviewer",
    "sandboxPolicy",
    "permissionProfile",
    "activePermissionProfile",
  ] as const) {
    if (
      !Object.hasOwn(resolvedSecurity, key) ||
      !Object.hasOwn(settings, key) ||
      !isDeepStrictEqual(settings[key], resolvedSecurity[key])
    )
      throw new Error(
        "Applied native security differs from its admitted resolution.",
      );
  }
  const patch = nativePermissionPatch(transition.effectiveId);
  if (
    settings.approvalPolicy !== patch.approvalPolicy ||
    settings.approvalsReviewer !== patch.approvalsReviewer ||
    !object(settings.activePermissionProfile) ||
    settings.activePermissionProfile.id !== patch.permissions
  )
    throw new Error(
      "Applied native security does not select the admitted permission profile.",
    );
  return {
    effectiveId: transition.effectiveId,
    settingsVersion: settings.settingsVersion,
  };
}
