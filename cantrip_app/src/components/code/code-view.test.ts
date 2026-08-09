import { describe, expect, it } from "vitest";

import { CantripApiError } from "@/lib/api";

import {
  codeReconnectDelayMs,
  isCodeAttachmentUnavailableMessage,
  isCodeSessionUnavailableError,
} from "./code-view";

describe("Cantrip Code reconnect delay", () => {
  it("backs off quickly and caps retries", () => {
    expect(codeReconnectDelayMs(0)).toBe(1_000);
    expect(codeReconnectDelayMs(1)).toBe(2_000);
    expect(codeReconnectDelayMs(3)).toBe(8_000);
    expect(codeReconnectDelayMs(8)).toBe(15_000);
  });

  it("treats negative attempts as the first retry", () => {
    expect(codeReconnectDelayMs(-4)).toBe(1_000);
  });

  it("recognizes only the isolated surface recovery message", () => {
    expect(
      isCodeAttachmentUnavailableMessage({
        type: "cantrip-code-attachment-unavailable-v1",
      }),
    ).toBe(true);
    expect(
      isCodeAttachmentUnavailableMessage({
        type: "cantrip-code-attachment-unavailable-v2",
      }),
    ).toBe(false);
    expect(isCodeAttachmentUnavailableMessage(null)).toBe(false);
  });

  it("recovers only from a worker that forgot an existing Code session", () => {
    expect(
      isCodeSessionUnavailableError(
        new CantripApiError("Cantrip Code session session-1 is not open.", 502),
      ),
    ).toBe(true);
    expect(
      isCodeSessionUnavailableError(
        new CantripApiError("Cantrip Code failed to start.", 502),
      ),
    ).toBe(false);
    expect(
      isCodeSessionUnavailableError(
        new CantripApiError("Cantrip Code session session-1 is not open.", 409),
      ),
    ).toBe(false);
  });
});
