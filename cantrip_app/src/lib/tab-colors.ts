import { useSyncExternalStore, type CSSProperties } from "react";
import type { ProjectSurface } from "./project-surface";

export const TAB_COLOR_PRESETS = [
  { label: "Red", hue: 0 },
  { label: "Amber", hue: 40 },
  { label: "Green", hue: 140 },
  { label: "Blue", hue: 215 },
  { label: "Purple", hue: 280 },
] as const;
const changedEvent = "cantrip:tab-color-changed";
export const TAB_COLOR_DIALOG_EVENT = "cantrip:tab-color-dialog";

export function tabColorKey(
  projectId: string,
  tabKey: string,
  filePath?: string | null,
) {
  return JSON.stringify([
    "cantrip:tab-color:v1",
    projectId,
    filePath ? "file" : "tab",
    filePath || tabKey,
  ]);
}

export function surfaceColorKey(surface: ProjectSurface) {
  return tabColorKey(
    surface.projectId,
    surface.tabKey,
    surface.kind === "explorer" ? surface.entity.selectedPath : null,
  );
}

export function parseTabHue(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const hue = Number(value);
  return Number.isFinite(hue) && hue >= 0 && hue <= 359 ? hue : null;
}

export function readTabHue(key: string): number | null {
  try {
    return parseTabHue(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function saveTabHue(key: string, hue: number | null) {
  if (hue !== null && (!Number.isFinite(hue) || hue < 0 || hue > 359))
    throw new Error("Choose a hue between 0 and 359.");
  if (hue === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, String(hue));
  window.dispatchEvent(new Event(changedEvent));
}

function subscribe(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", listener);
  window.addEventListener(changedEvent, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(changedEvent, listener);
  };
}

export function useTabHue(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => readTabHue(key),
    () => null,
  );
}

export function tabColorStyle(hue: number | null): CSSProperties {
  return hue === null ? {} : ({ "--tab-hue": hue } as CSSProperties);
}

export function openTabColorDialog(key: string, title: string) {
  window.dispatchEvent(
    new CustomEvent(TAB_COLOR_DIALOG_EVENT, { detail: { key, title } }),
  );
}
