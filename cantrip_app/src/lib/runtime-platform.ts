import { Capacitor } from "@capacitor/core";

export type ClientRuntimePlatform =
  | "browser"
  | "capacitor-android"
  | "capacitor-ios"
  | "tauri"
  | "unsupported-native";

export type RuntimePlatformProbe = {
  capacitorNative: boolean;
  capacitorPlatform: string;
  tauri: boolean;
};

function currentRuntimeProbe(): RuntimePlatformProbe {
  return {
    capacitorNative: Capacitor.isNativePlatform(),
    capacitorPlatform: Capacitor.getPlatform(),
    tauri: typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  };
}

export function detectClientRuntimePlatform(
  probe: RuntimePlatformProbe = currentRuntimeProbe(),
): ClientRuntimePlatform {
  if (probe.tauri) return "tauri";
  if (!probe.capacitorNative) return "browser";
  if (probe.capacitorPlatform === "ios") return "capacitor-ios";
  if (probe.capacitorPlatform === "android") return "capacitor-android";
  return "unsupported-native";
}

export function nativeInstallationStorageRequired(
  platform: ClientRuntimePlatform,
): boolean {
  return platform !== "browser";
}
