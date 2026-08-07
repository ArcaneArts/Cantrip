import { describe, expect, it } from "vitest";

import { discoverCodexVersion } from "../src/codex/discovery.js";

describe("discoverCodexVersion", () => {
  it("returns null when the configured binary is unavailable", async () => {
    await expect(
      discoverCodexVersion("/definitely/missing/cantrip-codex"),
    ).resolves.toBeNull();
  });
});
