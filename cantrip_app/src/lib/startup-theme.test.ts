import { afterEach, describe, expect, it, vi } from "vitest";

import startupHtml from "../../index.html?raw";

import {
  readStartupHighContrast,
  readStartupThemePreference,
  rememberStartupHighContrast,
  rememberStartupThemePreference,
  STARTUP_HIGH_CONTRAST_STORAGE_KEY,
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
    expect(STARTUP_HIGH_CONTRAST_STORAGE_KEY).toBe(
      "cantrip.theme.highContrast",
    );
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

  it.each([true, false])(
    "round-trips the high contrast value %s",
    (highContrast) => {
      const localStorage = new MemoryStorage();
      vi.stubGlobal("window", { localStorage });

      rememberStartupHighContrast(highContrast);

      expect(localStorage.values.get(STARTUP_HIGH_CONTRAST_STORAGE_KEY)).toBe(
        String(highContrast),
      );
      expect(readStartupHighContrast()).toBe(highContrast);
    },
  );

  it("ignores invalid or unavailable cached high contrast values", () => {
    const localStorage = new MemoryStorage();
    localStorage.values.set(STARTUP_HIGH_CONTRAST_STORAGE_KEY, "yes");
    vi.stubGlobal("window", { localStorage });
    expect(readStartupHighContrast()).toBeNull();

    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("storage disabled");
      },
    });
    expect(readStartupHighContrast()).toBeNull();
    expect(() => rememberStartupHighContrast(true)).not.toThrow();
  });

  it("resolves explicit and system preferences", () => {
    expect(startupThemeIsDark("dark", false)).toBe(true);
    expect(startupThemeIsDark("light", true)).toBe(false);
    expect(startupThemeIsDark("system", true)).toBe(true);
    expect(startupThemeIsDark("system", false)).toBe(false);
  });

  it("applies cached dark high contrast before the app renders", () => {
    const bootstrap = startupHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(bootstrap).toBeTruthy();

    const localStorage = new MemoryStorage();
    localStorage.setItem(STARTUP_THEME_STORAGE_KEY, "dark");
    localStorage.setItem(STARTUP_HIGH_CONTRAST_STORAGE_KEY, "true");
    const classes = new Map<string, boolean>();
    const style: Record<string, string> = {};
    const windowObject = {
      localStorage,
      matchMedia: vi.fn(() => ({ matches: false })),
    };
    const documentObject = {
      documentElement: {
        classList: {
          toggle: vi.fn((name: string, enabled: boolean) => {
            classes.set(name, enabled);
          }),
        },
        style,
      },
    };

    Function("window", "document", bootstrap!)(windowObject, documentObject);

    expect(classes.get("dark")).toBe(true);
    expect(classes.get("high-contrast")).toBe(true);
    expect(style.colorScheme).toBe("dark");
  });
});
