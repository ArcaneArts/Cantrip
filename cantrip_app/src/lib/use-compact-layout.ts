import { useEffect, useState } from "react";

export const COMPACT_LAYOUT_MEDIA_QUERY = "(max-width: 767px)";

function compactLayoutMatches(): boolean {
  return window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY).matches;
}

export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(compactLayoutMatches);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return compact;
}
