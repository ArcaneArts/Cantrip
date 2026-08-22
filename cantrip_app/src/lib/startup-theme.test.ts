import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readStartupThemePreference,
  rememberStartupThemePreference,
  STARTUP_THEME_STORAGE_KEY,
  startupThemeIsDark,
} from "./startup-theme";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("startup theme cache", () => {
  it("keeps a stable key for the pre-render HTML bootstrap", () => {
    expect(STARTUP_THEME_STORAGE_KEY).toBe("cantrip.theme.preference");
  });

  it.each(["dark", "light", "system"] as const)(
    "round-trips the %s preference",
    (preference) => {
      const localStorage = new MemoryStorage();
      vi.stubGlobal("window", { localStorage });

      rememberStartupThemePreference(preference);

      expect(localStorage.values.get(STARTUP_THEME_STORAGE_KEY)).toBe(
        preference,
      );
      expect(readStartupThemePreference()).toBe(preference);
    },
  );

  it("ignores invalid or unavailable cached values", () => {
    const localStorage = new MemoryStorage();
    localStorage.values.set(STARTUP_THEME_STORAGE_KEY, "sepia");
    vi.stubGlobal("window", { localStorage });
    expect(readStartupThemePreference()).toBeNull();

    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("storage disabled");
      },
    });
    expect(readStartupThemePreference()).toBeNull();
    expect(() => rememberStartupThemePreference("dark")).not.toThrow();
  });

  it("resolves explicit and system preferences", () => {
    expect(startupThemeIsDark("dark", false)).toBe(true);
    expect(startupThemeIsDark("light", true)).toBe(false);
    expect(startupThemeIsDark("system", true)).toBe(true);
    expect(startupThemeIsDark("system", false)).toBe(false);
  });
});
