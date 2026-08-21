import { ImpactStyle } from "@capacitor/haptics";
import { describe, expect, it, vi } from "vitest";

import { performMobileNavigationHaptic } from "./mobile-navigation-haptics";

describe("mobile navigation haptics", () => {
  it("uses a light impact while the tab is still pressed", async () => {
    const impact = vi.fn().mockResolvedValue(undefined);

    await performMobileNavigationHaptic("press", impact);

    expect(impact).toHaveBeenCalledWith({ style: ImpactStyle.Light });
  });

  it("uses a stronger impact when a hold resets the tab", async () => {
    const impact = vi.fn().mockResolvedValue(undefined);

    await performMobileNavigationHaptic("reset", impact);

    expect(impact).toHaveBeenCalledWith({ style: ImpactStyle.Medium });
  });

  it("keeps navigation best-effort when haptics are unavailable", async () => {
    await expect(
      performMobileNavigationHaptic(
        "press",
        vi.fn().mockRejectedValue(new Error("unavailable")),
      ),
    ).resolves.toBeUndefined();
  });
});
