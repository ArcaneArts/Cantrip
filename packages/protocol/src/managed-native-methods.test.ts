import { describe, expect, it } from "vitest";
import { managedNativeMethods } from "./managed-native-methods.js";

describe("Codex 0.160 managed method inventory", () => {
  it.each([
    ["thread/attachment/list", "read"],
    ["userVerification/status", "read"],
    ["memory/status", "read"],
    ["thread/attachment/add", "mutation"],
    ["thread/attachment/remove", "mutation"],
    ["account/gatewayOAuth/read", "mutation"],
    ["account/gatewayOAuth/login", "mutation"],
    ["account/gatewayOAuth/cancel", "mutation"],
    ["userVerification/enroll", "mutation"],
    ["userVerification/delete", "mutation"],
    ["userVerification/verify", "mutation"],
    ["userVerification/cancel", "mutation"],
    ["rollout/compress", "mutation"],
  ])("classifies %s without bypassing admission", (method, kind) => {
    expect(managedNativeMethods.get(method)).toBe(kind);
  });

  it("retires the removed rollback method without removing supported revert", () => {
    expect(managedNativeMethods.has("thread/rollback")).toBe(false);
    expect(managedNativeMethods.get("thread/revert")).toBe("mutation");
  });
});
