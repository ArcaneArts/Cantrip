import { describe, expect, it, vi } from "vitest";

import { ShortLivedRequestCache } from "./short-lived-request-cache";

describe("ShortLivedRequestCache", () => {
  it("coalesces concurrent loads and briefly reuses the result", async () => {
    const cache = new ShortLivedRequestCache<string>(1_000);
    const load = vi.fn(async () => "ready");

    const first = cache.get("worker", load);
    const second = cache.get("worker", load);

    await expect(Promise.all([first, second])).resolves.toEqual([
      "ready",
      "ready",
    ]);
    await expect(cache.get("worker", load)).resolves.toBe("ready");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not retain failed loads", async () => {
    const cache = new ShortLivedRequestCache<string>(1_000);
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("ready");

    await expect(cache.get("worker", load)).rejects.toThrow("offline");
    await expect(cache.get("worker", load)).resolves.toBe("ready");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
