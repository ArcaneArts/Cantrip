import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export const COMPACT_LAYOUT_MEDIA_QUERY = "(max-width: 767px)";

export function shouldUseCompactLayout(
  mediaQueryMatches: boolean,
  tauriRuntime: boolean,
): boolean {
  return mediaQueryMatches && !tauriRuntime;
}

export function shouldUseDesktopSidebarDrawer(
  mediaQueryMatches: boolean,
  tauriRuntime: boolean,
  popout: boolean,
): boolean {
  return mediaQueryMatches && tauriRuntime && !popout;
}

export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return narrow;
}

export function useCompactLayout(): boolean {
  return shouldUseCompactLayout(useNarrowViewport(), isTauri());
}
