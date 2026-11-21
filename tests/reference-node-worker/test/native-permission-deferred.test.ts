import { describe, expect, it } from "vitest";
import { isNativePermissionDeferred } from "../src/codex/native-permission-deferred.js";

describe("native pending-permission non-admission", () => {
  const frame = {
    error: {
      code: -32001,
      message: "input not consumed",
      data: { reason: "pendingSettings", inputConsumed: false },
    },
  };
  it("accepts only the explicit turn/start code and no-consumption evidence", () => {
    expect(isNativePermissionDeferred("turn/start", frame)).toBe(true);
    expect(isNativePermissionDeferred("turn/steer", frame)).toBe(false);
    expect(
      isNativePermissionDeferred("turn/start", {
        error: { ...frame.error, code: -32000 },
      }),
    ).toBe(false);
    expect(
      isNativePermissionDeferred("turn/start", {
        error: {
          ...frame.error,
          data: { reason: "pendingSettings", inputConsumed: true },
        },
      }),
    ).toBe(false);
    expect(
      isNativePermissionDeferred("turn/start", {
        error: { code: -32001, message: "pendingSettings inputConsumed=false" },
      }),
    ).toBe(false);
    expect(isNativePermissionDeferred("turn/start", null)).toBe(false);
  });
});
