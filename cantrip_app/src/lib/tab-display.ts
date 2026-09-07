import { useEffect, useState, useSyncExternalStore } from "react";

export type TabDisplayMode = "tabs" | "icons" | "hybrid";
export type ConfigurableTabBar = "top" | "bottom";
const eventName = "cantrip:tab-display-changed";
const key = (bar: ConfigurableTabBar) => `cantrip:tab-display:v1:${bar}`;
export function parseTabDisplay(
  value: string | null,
  bar: ConfigurableTabBar,
): TabDisplayMode {
  return value === "tabs" || value === "icons" || value === "hybrid"
    ? value
    : bar === "top"
      ? "tabs"
      : "icons";
}
export function readTabDisplay(bar: ConfigurableTabBar) {
  try {
    return parseTabDisplay(window.localStorage.getItem(key(bar)), bar);
  } catch {
    return parseTabDisplay(null, bar);
  }
}
export function saveTabDisplay(bar: ConfigurableTabBar, mode: TabDisplayMode) {
  window.localStorage.setItem(key(bar), mode);
  window.dispatchEvent(new Event(eventName));
}
function subscribe(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(eventName, listener);
  };
}
export function useTabDisplay(bar: ConfigurableTabBar) {
  return useSyncExternalStore(
    subscribe,
    () => readTabDisplay(bar),
    () => parseTabDisplay(null, bar),
  );
}

// Hybrid uses a stable 160px label slot or a 40px icon slot, reserving the
// add button and padding. Collapse from the end; never reorder tabs.
export function expandedTabCount(
  mode: TabDisplayMode,
  count: number,
  width: number,
) {
  if (mode === "tabs") return count;
  if (mode === "icons") return 0;
  return Math.max(
    0,
    Math.min(count, Math.floor((width - 48 - count * 40) / 120)),
  );
}
export function useTabBarWidth() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { setElement, width };
}
