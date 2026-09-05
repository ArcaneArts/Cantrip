import { YOLO_PERMISSION_PROFILE_ID } from "@cantrip/protocol";
import {
  computerUseOperationSchema,
  type ComputerUseOperation,
} from "@cantrip/protocol/computer-use";
import { describe, expect, it } from "vitest";

import {
  computerUsePermissionDecision,
  type CuaPermissionClass,
  type CuaPermissionProfile,
} from "./permission-policy.js";

const restricted: CuaPermissionProfile = {
  selectedId: ":read-only",
  effectiveId: ":read-only",
  forcedByWorktreePolicy: false,
};

const expectedClasses: Record<ComputerUseOperation, CuaPermissionClass[]> = {
  "capabilities.get": [],
  "agent.sources.list": [],
  "agent.observation.get": [],
  "targets.list": ["inventory"],
  "session.open": ["inventory"],
  "session.state": ["inventory"],
  "target.attach": ["inventory"],
  "target.detach": ["cursor"],
  "cursor.configure": ["cursor"],
  "cursor.move": ["cursor"],
  "controls.inspect": ["controls"],
  "input.press": ["native-input"],
  "input.click": ["native-input"],
  "observation.snapshot": ["capture"],
  "session.close": [],
};

describe("computer-use permission policy", () => {
  it.each(computerUseOperationSchema.options)(
    "maps %s to its actual operation class and existing approval requirement",
    (operation) => {
      const classes = expectedClasses[operation];
      expect(computerUsePermissionDecision(operation, restricted)).toEqual({
        kind: classes.length ? "approval-required" : "allow",
        classes,
      });
    },
  );

  it.each([
    { effectiveId: YOLO_PERMISSION_PROFILE_ID, forcedByWorktreePolicy: false },
    { effectiveId: ":read-only", forcedByWorktreePolicy: true },
    { effectiveId: ":read-only", forcedByWorktreePolicy: false },
    { effectiveId: "unknown-effective-profile", forcedByWorktreePolicy: true },
  ])("does not add a confirmation to selected YOLO (%j)", (effective) => {
    for (const operation of computerUseOperationSchema.options) {
      expect(
        computerUsePermissionDecision(operation, {
          selectedId: YOLO_PERMISSION_PROFILE_ID,
          ...effective,
        }),
      ).toEqual({ kind: "allow", classes: expectedClasses[operation] });
    }
  });

  it.each([
    "unknown-profile",
    "custom-yolo",
    ":yolo-custom",
    "yolo",
    ":YOLO",
    ":danger-full-access",
    ":read-only",
    "",
  ])(
    "does not infer YOLO from selected profile %j or an effective override",
    (selectedId) => {
      for (const effectiveId of [selectedId, YOLO_PERMISSION_PROFILE_ID]) {
        for (const forcedByWorktreePolicy of [false, true]) {
          for (const operation of computerUseOperationSchema.options) {
            const classes = expectedClasses[operation];
            expect(
              computerUsePermissionDecision(operation, {
                selectedId,
                effectiveId,
                forcedByWorktreePolicy,
              }),
            ).toEqual({
              kind: classes.length ? "approval-required" : "allow",
              classes,
            });
          }
        }
      }
    },
  );

  it("does not treat structured read-only Codex approvalPolicy never as YOLO", () => {
    const structuredReadOnly = {
      ...restricted,
      approvalPolicy: "never",
      sandbox: "read-only",
    };
    for (const operation of [
      "targets.list",
      "observation.snapshot",
      "cursor.move",
    ] as const) {
      expect(
        computerUsePermissionDecision(operation, structuredReadOnly).kind,
      ).toBe("approval-required");
    }
  });

  it("does not mutate the selected/effective profile or share mutable class arrays", () => {
    const profile = Object.freeze({ ...restricted });
    const first = computerUsePermissionDecision(
      "observation.snapshot",
      profile,
    );
    first.classes.push("cursor");
    expect(
      computerUsePermissionDecision("observation.snapshot", profile),
    ).toEqual({ kind: "approval-required", classes: ["capture"] });
    expect(profile).toEqual(restricted);
  });
});
