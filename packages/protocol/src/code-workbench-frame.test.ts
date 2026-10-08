import { describe, expect, it } from "vitest";
import { codeWorkbenchFrameFailureMessageSchema } from "./code-workbench-frame.js";

describe("Code workbench frame HTTP failure contract", () => {
  const message = {
    type: "cantrip-code.frame-load-failed",
    version: 1,
    nonce: "frame_nonce_1234567890",
    statusCode: 503,
  };

  it.each([400, 599])("accepts HTTP failure boundary %s", (statusCode) => {
    expect(
      codeWorkbenchFrameFailureMessageSchema.parse({ ...message, statusCode }),
    ).toEqual({ ...message, statusCode });
  });

  it.each([
    { ...message, type: "cantrip-code.workbench-ready" },
    { ...message, version: 2 },
    { ...message, nonce: "short" },
    { ...message, nonce: "x".repeat(129) },
    { ...message, nonce: "<script>alert(1)</script>" },
    { ...message, statusCode: 399 },
    { ...message, statusCode: 600 },
    { ...message, statusCode: 503.5 },
    { ...message, statusCode: "503" },
    { ...message, extra: true },
  ])("rejects invalid message %#", (invalid) => {
    expect(
      codeWorkbenchFrameFailureMessageSchema.safeParse(invalid).success,
    ).toBe(false);
  });
});
