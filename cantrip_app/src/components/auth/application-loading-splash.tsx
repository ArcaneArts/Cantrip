import { useEffect, useState } from "react";

import { SessionWindowDragRegion } from "@/components/auth/session-window-drag-region";
import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  EliteReveal,
  type EliteRevealConfig,
} from "@/components/elite/elite-reveal";
import { isMacosDesktopRuntime } from "@/lib/desktop-popout";

import "./application-loading-splash.css";

export const APPLICATION_SPLASH_GLITCH_INTERVAL_MS = 100;

export const APPLICATION_SPLASH_GLITCH_CONFIG: EliteRevealConfig = {
  ...DEFAULT_ELITE_REVEAL_CONFIG,
  glitchCountMax: 1,
  glitchCountMin: 1,
  glitchShowMs: 72,
  staggerSpreadMs: 0,
  variants: ["chromatic", "spatial-shift", "scanline"],
  variantWeights: {
    ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
    chromatic: 1,
    scanline: 1,
    "spatial-shift": 1,
  },
};

export function ApplicationLoadingSplash() {
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = window.setInterval(
      () => setReplayKey((current) => current + 1),
      APPLICATION_SPLASH_GLITCH_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, []);

  return (
    <>
      <SessionWindowDragRegion enabled={isMacosDesktopRuntime()} />
      <main className="application-loading-splash">
        <div
          className="application-loading-splash__brand"
          data-application-loading-splash=""
        >
          <EliteReveal
            className="application-loading-splash__logo"
            config={APPLICATION_SPLASH_GLITCH_CONFIG}
            contentKind="box"
            replayKey={replayKey}
          >
            <span
              aria-hidden="true"
              className="application-loading-splash__mark"
            />
          </EliteReveal>
          <h1 className="application-loading-splash__name">Cantrip</h1>
        </div>
      </main>
    </>
  );
}
