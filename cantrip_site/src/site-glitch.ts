import { DEFAULT_ELITE_REVEAL_CONFIG } from "@cantrip/glitch";
import type { EliteRevealConfig } from "@cantrip/glitch";
import { useEffect, useState } from "react";

export const SITE_REDUCED_MOTION_GLITCH_CONFIG: EliteRevealConfig = {
  ...DEFAULT_ELITE_REVEAL_CONFIG,
  variants: [],
};

export function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}
