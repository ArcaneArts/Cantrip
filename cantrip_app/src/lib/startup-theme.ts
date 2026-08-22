export const STARTUP_THEME_STORAGE_KEY = "cantrip.theme.preference";

export type StartupThemePreference = "dark" | "light" | "system";

function isStartupThemePreference(
  value: string | null,
): value is StartupThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

export function readStartupThemePreference(): StartupThemePreference | null {
  try {
    if (typeof window === "undefined") return null;
    const value = window.localStorage.getItem(STARTUP_THEME_STORAGE_KEY);
    return isStartupThemePreference(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberStartupThemePreference(
  preference: StartupThemePreference,
): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STARTUP_THEME_STORAGE_KEY, preference);
  } catch {
    // The cache is only a first-paint hint, so storage failures are harmless.
  }
}

export function startupThemeIsDark(
  preference: StartupThemePreference,
  systemDark: boolean,
): boolean {
  return preference === "dark" || (preference === "system" && systemDark);
}
