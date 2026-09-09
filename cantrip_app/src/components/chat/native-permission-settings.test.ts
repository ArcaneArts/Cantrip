import { describe, expect, it } from "vitest";
import type { NativeThreadSettings } from "@cantrip/protocol";
import {
  isNativePermissionPatch,
  nativePermissionPreset,
  nativePermissionSelection,
  requestedNativePermissions,
} from "./native-permission-settings";
const confirmed = {
  activePermissionProfile: { id: ":workspace", extends: null },
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "workspaceWrite" },
} as unknown as NativeThreadSettings;
describe("native permission selection", () => {
  it("keeps native applied security separate from pending named profile expansion", () => {
    const selected = requestedNativePermissions(confirmed, [
      { permissions: ":danger-full-access", approvalPolicy: "never" },
    ]);
    expect(selected).toEqual({
      profileId: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: null,
    });
    expect(nativePermissionSelection(confirmed).profileId).toBe(":workspace");
    expect(nativePermissionPreset(selected)).toBeNull();
    expect(
      nativePermissionPreset({
        ...selected,
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    ).toBe(":yolo");
  });
  it("does not treat native null security values as an account-default selection", () => {
    expect(
      requestedNativePermissions(confirmed, [
        {
          permissions: null,
          approvalPolicy: null,
          sandboxPolicy: null,
          approvalsReviewer: null,
        },
      ]),
    ).toEqual(nativePermissionSelection(confirmed));
    expect(isNativePermissionPatch({ permissions: null })).toBe(false);
    expect(isNativePermissionPatch({ permissions: ":read-only" })).toBe(true);
    expect(isNativePermissionPatch({ model: "new-model" })).toBe(false);
  });
  it("preserves custom TUI policies without calling them YOLO or replaying old profile provenance", () => {
    const selection = requestedNativePermissions(confirmed, [
      {
        sandboxPolicy: { type: "dangerFullAccess" },
        approvalPolicy: { reject: { sandbox_approval: true } },
      },
    ]);
    expect(selection.profileId).toBeNull();
    expect(selection.approvalPolicy).toEqual({
      reject: { sandbox_approval: true },
    });
    expect(nativePermissionPreset(selection)).toBeNull();
    expect(
      nativePermissionPreset({
        ...selection,
        profileId: ":danger-full-access",
      }),
    ).toBeNull();
  });
});
