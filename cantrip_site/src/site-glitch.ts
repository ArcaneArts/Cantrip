import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  type EliteRevealConfig,
} from "@cantrip/glitch";
import { useEffect, useState } from "react";

export const SITE_HERO_GLITCH_CONFIG: EliteRevealConfig = {
  ...DEFAULT_ELITE_REVEAL_CONFIG,
  glitchCountMax: 6,
  glitchCountMin: 4,
  glitchShowMs: 18,
  staggerSpreadMs: 0,
  variants: ["outline", "spatial-shift", "scanline"],
  variantWeights: {
    ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
    chromatic: 0,
    "full-frame": 0,
    "left-frame": 0,
    outline: 0.8,
    "right-frame": 0,
    scanline: 0.6,
    "spatial-shift": 1,
    "text-jitter": 0,
  },
};

export const SITE_DEMO_GLITCH_CONFIG: EliteRevealConfig = {
  ...DEFAULT_ELITE_REVEAL_CONFIG,
  glitchCountMax: 4,
  glitchCountMin: 2,
  glitchShowMs: 18,
  staggerSpreadMs: 0,
  variants: ["outline", "spatial-shift", "scanline"],
  variantWeights: {
    ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
    chromatic: 0,
    "full-frame": 0,
    "left-frame": 0,
    outline: 1,
    "right-frame": 0,
    scanline: 0.45,
    "spatial-shift": 1,
    "text-jitter": 0,
  },
};

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
