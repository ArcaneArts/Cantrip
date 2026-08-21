import { describe, expect, it } from "vitest";

import { liveResourceRefreshInterval } from "./live-resource-refresh";

describe("liveResourceRefreshInterval", () => {
  it("disables polling while AppLive is healthy", () => {
    expect(liveResourceRefreshInterval(true, 1_000)).toBe(false);
  });

  it("preserves bounded polling while AppLive is degraded", () => {
    expect(liveResourceRefreshInterval(false, 1_000)).toBe(1_000);
    expect(liveResourceRefreshInterval(false, false)).toBe(false);
  });
});
