import { describe, expect, it } from "vitest";
import { permissionTransitionSchema } from "../src/permission-profiles.js";
import { nativePermissionUpdateCommandSchema } from "../src/native-settings-update.js";
import { nativeSettingsEvidenceSchema } from "../src/native-settings-evidence.js";
const transition = {
  selectedId: null,
  resolvedSelectedId: ":yolo",
  effectiveId: ":read-only",
  expectedRevision: "0",
};
describe("permission transition wire metadata", () => {
  it("retains preference/default/forced effective separately and requires an exact bound source", () => {
    expect(permissionTransitionSchema.parse(transition)).toEqual(transition);
    expect(
      permissionTransitionSchema.safeParse({
        ...transition,
        expectedRevision: "-1",
      }).success,
    ).toBe(false);
    expect(
      nativePermissionUpdateCommandSchema.safeParse({
        type: "chat.permissions.update",
        operationId: "operation",
        permissionTransition: transition,
      }).success,
    ).toBe(false);
  });
  it("allows public policy claims only for correlated applied evidence", () => {
    const event = {
      workerId: "worker",
      operationId: "operation",
      operationGeneration: "generation",
      eventId: "4ecda31d-212f-43b1-87f0-216cc54dd3d2",
      threadId: "thread",
      runtimeGeneration: "runtime",
      nativeOperationId: "native-op",
      submissionId: "submission",
      kind: "applied",
      resultDigest: "a".repeat(64),
      protectedResult: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
      permissionPolicy: {
        effectiveId: ":read-only",
        settingsVersion: { epoch: "epoch", revision: "1" },
      },
    };
    expect(nativeSettingsEvidenceSchema.safeParse(event).success).toBe(true);
    expect(
      nativeSettingsEvidenceSchema.safeParse({
        ...event,
        recoveryBindingId: "current-binding",
      }).success,
    ).toBe(true);
    expect(
      nativeSettingsEvidenceSchema.safeParse({
        ...event,
        recoveryBindingId: "current-binding",
        permissionPolicy: undefined,
      }).success,
    ).toBe(false);
    expect(
      nativeSettingsEvidenceSchema.safeParse({
        ...event,
        recoveryBindingId: "current-binding",
        kind: "queued",
        permissionPolicy: undefined,
      }).success,
    ).toBe(false);
    expect(
      nativeSettingsEvidenceSchema.safeParse({ ...event, kind: "queued" })
        .success,
    ).toBe(false);
    expect(
      nativeSettingsEvidenceSchema.safeParse({ ...event, submissionId: null })
        .success,
    ).toBe(false);
  });
});
