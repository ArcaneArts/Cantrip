import { describe, expect, it } from "vitest";

import { codeReconnectDelayMs } from "./code-view";

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
});
