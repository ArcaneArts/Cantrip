import { describe, expect, it } from "vitest";
import { computerUsePermissionDecision } from "./permission-policy.js";
import { cuaJavascriptActionSchema } from "./javascript.js";
import { CuaNativeError } from "./errors.js";

describe("native press contract", () => {
  it("keeps ordinary cursor clicks separate from explicit global input", () => {
    expect(cuaJavascriptActionSchema.parse({ operation: "click" })).toEqual({
      operation: "click",
    });
    expect(
      cuaJavascriptActionSchema.safeParse({
        operation: "click",
        globalInput: true,
      }).success,
    ).toBe(false);
    expect(
      cuaJavascriptActionSchema.safeParse({ operation: "globalClick" }).success,
    ).toBe(false);
    expect(
      cuaJavascriptActionSchema.safeParse({
        operation: "globalClick",
        point: { x: 12, y: 15 },
      }).success,
    ).toBe(true);
  });
  it("cannot reuse observation or logical cursor grants for native input", () => {
    const profile = {
      selectedId: ":read-only",
      effectiveId: ":read-only",
      forcedByWorktreePolicy: false,
    };
    expect(computerUsePermissionDecision("input.press", profile)).toEqual({
      kind: "approval-required",
      classes: ["native-input"],
    });
    for (const operation of [
      "controls.inspect",
      "cursor.move",
      "observation.snapshot",
    ] as const)
      expect(
        computerUsePermissionDecision(operation, profile).classes,
      ).not.toContain("native-input");
  });
  it("keeps input authority out of model arguments", () => {
    expect(
      cuaJavascriptActionSchema.safeParse({
        operation: "press",
        reference: "control-1",
      }).success,
    ).toBe(true);
    for (const extra of [
      { sessionId: "other" },
      { targetId: "other" },
      { workerId: "other" },
      { repeat: 2 },
      { fallback: true },
    ])
      expect(
        cuaJavascriptActionSchema.safeParse({
          operation: "press",
          reference: "control-1",
          ...extra,
        }).success,
      ).toBe(false);
  });
  it("distinguishes uncertain action dispatch from unsupported actions", () => {
    expect(new CuaNativeError("input-unknown").message).toContain(
      "Do not retry",
    );
    expect(new CuaNativeError("unsupported").code).not.toBe("input-unknown");
  });
});
