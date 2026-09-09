import { describe, expect, it } from "vitest";
import { chatPermissionProfileStateSchema } from "@cantrip/protocol";
import { nativePermissionControlState } from "./native-permission-control-state";
import type { NativeSettingsController } from "./use-native-settings-controller";
function session() {
  return {
    binding: { bindingId: "binding" },
    observed: {
      confirmed: {
        activePermissionProfile: { id: ":workspace" },
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite" },
      },
      encryption: { status: "ready" },
      intents: [],
    },
    localPermission: null,
    pendingPatches: [],
    error: null,
  } as unknown as NativeSettingsController;
}
const preference = chatPermissionProfileStateSchema.parse({
  available: true,
  profiles: [],
  reason: null,
  selectedId: ":yolo",
  effectiveId: ":read-only",
  defaultId: ":workspace",
  usesDefault: false,
  forcedByWorktreePolicy: true,
});
describe("bound permission presentation", () => {
  it("does not replace actual native security with a requested or Primary-forced profile label", () => {
    const result = nativePermissionControlState(session(), preference);
    expect(result.confirmedPresetId).toBe(":workspace");
    expect(result.confirmed?.sandboxPolicy).toEqual({ type: "workspaceWrite" });
  });
  it("keeps account-default preference pending while the old security remains confirmed", () => {
    const current = session();
    current.localPermission = {
      permissionSelection: { id: null, expectedRevision: "0" },
      status: "queued",
    } as NativeSettingsController["localPermission"];
    const result = nativePermissionControlState(current, preference);
    expect(result.requestedLabel).toBe("Account default");
    expect(result.status).toBe("queued");
    expect(result.confirmedPresetId).toBe(":workspace");
  });
  it("shows native TUI pending security patches without replaying them", () => {
    const current = session();
    current.observed.intents = [
      {
        operationId: "native",
        status: "dispatched",
        pending: true,
        patch: { permissions: ":danger-full-access", approvalPolicy: "never" },
      },
    ];
    current.pendingPatches = current.observed.intents.map(
      (intent) => intent.patch,
    );
    const result = nativePermissionControlState(current, preference);
    expect(result.requestedLabel).toBe("Full access");
    expect(result.status).toBe("queued");
    expect(result.confirmedPresetId).toBe(":workspace");
  });
  it("does not expose stale source confirmation when the current binding is unavailable", () => {
    const current = session();
    current.binding = null;
    const result = nativePermissionControlState(current, preference);
    expect(result.confirmed).toBeNull();
    expect(result.confirmedPresetId).toBeNull();
    expect(result.disabled).toBe(true);
  });
  it("does not let an old applied preference response hide a newer native pending permission change", () => {
    const current = session();
    current.observed.intents = [
      {
        operationId: "new-native",
        status: "dispatched",
        pending: true,
        patch: { permissions: ":danger-full-access", approvalPolicy: "never" },
      },
    ];
    current.pendingPatches = current.observed.intents.map(
      (intent) => intent.patch,
    );
    const prior = {
      ...preference,
      transition: {
        selectedId: ":read-only",
        resolvedSelectedId: ":read-only",
        effectiveId: ":read-only",
        expectedRevision: "0",
        operationId: "old-op",
        status: "applied" as const,
      },
    };
    const result = nativePermissionControlState(current, prior);
    expect(result.status).toBe("queued");
    expect(result.requestedLabel).toBe("Full access");
    expect(result.confirmedPresetId).toBe(":workspace");
  });
});
