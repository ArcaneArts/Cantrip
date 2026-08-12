import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export const COMPACT_LAYOUT_MEDIA_QUERY = "(max-width: 767px)";

export function shouldUseCompactLayout(
  mediaQueryMatches: boolean,
  tauriRuntime: boolean,
): boolean {
  return mediaQueryMatches && !tauriRuntime;
}

function compactLayoutMatches(): boolean {
  return shouldUseCompactLayout(
    window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY).matches,
    isTauri(),
  );
}

export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(compactLayoutMatches);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY);
    const tauriRuntime = isTauri();
    const update = () =>
      setCompact(shouldUseCompactLayout(media.matches, tauriRuntime));
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return compact;
}
