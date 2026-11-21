import { describe, expect, it } from "vitest";
import { nativeThreadSettingsSchema } from "@cantrip/protocol";
import {
  applyNativePermissionTransition,
  confirmedNativePermissionClaim,
  hasNativePermissionUpdate,
  nativePermissionPatch,
  requestedNativePermissionProfile,
} from "../src/codex/managed-native-permissions.js";

const transition = {
  selectedId: null,
  resolvedSelectedId: ":workspace",
  effectiveId: ":workspace",
  expectedRevision: "0",
};
const security = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: ["/workspace"],
    networkAccess: false,
  },
  permissionProfile: { type: "workspace", root: "/workspace" },
  activePermissionProfile: { id: ":workspace", extends: null },
};
const settings = nativeThreadSettingsSchema.parse({
  ...security,
  settingsVersion: { epoch: "epoch", revision: "1" },
  cwd: "/workspace",
  model: "fixture",
  modelProvider: "fixture",
  effort: null,
  serviceTier: null,
  summary: null,
  collaborationMode: { mode: "default", settings: {} },
  personality: null,
});
describe("managed native permission transitions", () => {
  it("distinguishes full access from YOLO using the actual approval pairing", () => {
    expect(
      requestedNativePermissionProfile(
        { permissions: ":danger-full-access", approvalPolicy: "never" },
        {},
      ),
    ).toBe(":yolo");
    expect(
      requestedNativePermissionProfile(
        { permissions: ":danger-full-access", approvalPolicy: "on-request" },
        {},
      ),
    ).toBe(":danger-full-access");
    expect(nativePermissionPatch(":yolo")).toEqual({
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
  });
  it("preserves omitted active selector when changing a supported approval policy", () => {
    expect(
      requestedNativePermissionProfile(
        { approvalPolicy: "never" },
        { permissions: ":danger-full-access", approvalsReviewer: "user" },
      ),
    ).toBe(":yolo");
    expect(hasNativePermissionUpdate({ permissions: null, model: "new" })).toBe(
      false,
    );
  });
  it.each([
    { permissions: ":workspace", approvalPolicy: "never" },
    {
      permissions: ":workspace",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
    {
      permissions: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
    },
    { sandboxPolicy: { type: "readOnly" } },
  ])(
    "rejects custom security rather than guessing a managed profile: %j",
    (params) => {
      expect(() => requestedNativePermissionProfile(params, {})).toThrow();
    },
  );
  it("normalizes the exact authorized target while retaining non-security settings and identity", () => {
    expect(
      applyNativePermissionTransition(
        {
          threadId: "thread",
          operationId: "op",
          permissions: ":yolo",
          model: "new",
        },
        { ...transition, effectiveId: ":read-only" },
      ),
    ).toEqual({
      threadId: "thread",
      operationId: "op",
      model: "new",
      permissions: ":read-only",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      applyAt: "quiescent",
    });
  });
  it("requires the complete native resolved tuple and matching versioned application", () => {
    expect(
      confirmedNativePermissionClaim({
        transition,
        settings,
        resolvedSecurity: security,
      }),
    ).toEqual({
      effectiveId: ":workspace",
      settingsVersion: { epoch: "epoch", revision: "1" },
    });
    expect(() =>
      confirmedNativePermissionClaim({
        transition,
        settings,
        resolvedSecurity: undefined,
      }),
    ).toThrow("resolution");
    expect(() =>
      confirmedNativePermissionClaim({
        transition,
        settings: { ...settings, settingsVersion: undefined },
        resolvedSecurity: security,
      }),
    ).toThrow("resolution");
  });
  it.each([
    "approvalPolicy",
    "approvalsReviewer",
    "sandboxPolicy",
    "permissionProfile",
    "activePermissionProfile",
  ])("rejects mismatched %s even when profile name matches", (key) => {
    expect(() =>
      confirmedNativePermissionClaim({
        transition,
        settings,
        resolvedSecurity: { ...security, [key]: null },
      }),
    ).toThrow("differs");
  });
  it("rejects a matching tuple that belongs to a different requested profile", () => {
    expect(() =>
      confirmedNativePermissionClaim({
        transition: { ...transition, effectiveId: ":read-only" },
        settings,
        resolvedSecurity: security,
      }),
    ).toThrow("admitted permission profile");
  });
});
