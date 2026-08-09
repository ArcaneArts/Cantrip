import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from "@cantrip/protocol";

export { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH };

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)),
  );
}

export function sidebarWidthFromPointer(
  clientX: number,
  sidebarLeft = 0,
): number {
  return clampSidebarWidth(clientX - sidebarLeft);
}

export function sidebarWidthFromKey(
  currentWidth: number,
  key: string,
): number | null {
  if (key === "Home") return MIN_SIDEBAR_WIDTH;
  if (key === "End") return MAX_SIDEBAR_WIDTH;
  if (key === "ArrowLeft") return clampSidebarWidth(currentWidth - 16);
  if (key === "ArrowRight") return clampSidebarWidth(currentWidth + 16);
  return null;
}
