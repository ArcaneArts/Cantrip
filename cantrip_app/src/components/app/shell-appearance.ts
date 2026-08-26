import type { CodeAppearance, SettingsBundle } from "@cantrip/protocol";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { codeAppearanceFor } from "@/components/app/application-shell-model";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import {
  desktopWindowThemeOverride,
  isMacosDesktopRuntime,
  updateDesktopWindowTheme,
  updateMacosProMode,
} from "@/lib/desktop-popout";
import {
  readStartupHighContrast,
  readStartupThemePreference,
  rememberStartupHighContrast,
  rememberStartupThemePreference,
  startupThemeIsDark,
} from "@/lib/startup-theme";

export function useShellAppearanceState() {
  const [codeAppearance, setCodeAppearance] = useState<CodeAppearance>(() =>
    codeAppearanceFor(
      document.documentElement.classList.contains("dark"),
      document.documentElement.classList.contains("high-contrast"),
      false,
    ),
  );
  const [proModeActive, setProModeActive] = useState(false);
  return {
    codeAppearance,
    proModeActive,
    setCodeAppearance,
    setProModeActive,
  } as const;
}

export function useShellAppearanceEffects({
  preferences,
  proModeActive,
  setCodeAppearance,
  setProModeActive,
}: {
  preferences: SettingsBundle["preferences"] | undefined;
  proModeActive: boolean;
  setCodeAppearance: Dispatch<SetStateAction<CodeAppearance>>;
  setProModeActive: Dispatch<SetStateAction<boolean>>;
}) {
  useEffect(() => {
    const configuredPreference = preferences?.theme;
    const configuredHighContrast = preferences?.highContrast;
    const preference =
      configuredPreference ?? readStartupThemePreference() ?? "system";
    const highContrast =
      configuredHighContrast ?? readStartupHighContrast() ?? false;
    if (configuredPreference) {
      rememberStartupThemePreference(configuredPreference);
    }
    if (configuredHighContrast !== undefined) {
      rememberStartupHighContrast(configuredHighContrast);
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let active = true;
    const apply = () => {
      const dark = startupThemeIsDark(preference, media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle("high-contrast", highContrast);
      setCodeAppearance(codeAppearanceFor(dark, highContrast, proModeActive));
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    if (preference === "system") {
      media.addEventListener("change", apply);
    }
    void updateDesktopWindowTheme(desktopWindowThemeOverride(preference))
      .then(() => {
        if (active && preference === "system") apply();
      })
      .catch((error: unknown) => {
        clientLogger.warn("Desktop window theme update failed", {
          ...operationalErrorMetadata(error),
          event: "window.theme.failed",
          operation: "set-theme",
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
      });
    return () => {
      active = false;
      if (preference === "system") {
        media.removeEventListener("change", apply);
      }
    };
  }, [
    preferences?.highContrast,
    preferences?.theme,
    proModeActive,
    setCodeAppearance,
  ]);

  useEffect(() => {
    const opacity = preferences?.proModeOpacity ?? 80;
    document.documentElement.style.setProperty(
      "--pro-mode-opacity",
      `${opacity}%`,
    );
  }, [preferences?.proModeOpacity]);

  useEffect(() => {
    const requested = preferences?.proMode ?? false;
    const supported = isMacosDesktopRuntime();
    let active = true;
    document.documentElement.classList.toggle(
      "pro-mode",
      supported && requested,
    );
    setProModeActive(supported && requested);
    if (!supported) return;
    void updateMacosProMode(requested)
      .then((enabled) => {
        if (active) {
          document.documentElement.classList.toggle("pro-mode", enabled);
          setProModeActive(enabled);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          document.documentElement.classList.remove("pro-mode");
          setProModeActive(false);
        }
        clientLogger.warn("macOS Pro Mode update failed", {
          ...operationalErrorMetadata(error),
          event: "window.pro-mode.failed",
          operation: "set-pro-mode",
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
      });
    return () => {
      active = false;
    };
  }, [preferences?.proMode, setProModeActive]);
}
