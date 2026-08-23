import { useEffect, useState } from "react";

import { SessionWindowDragRegion } from "@/components/auth/session-window-drag-region";
import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  EliteReveal,
  type EliteRevealConfig,
} from "@/components/elite/elite-reveal";
import { isMacosDesktopRuntime } from "@/lib/desktop-popout";

import "./application-loading-splash.css";

export const APPLICATION_SPLASH_BOLT_GLITCH_INTERVAL_MS = 48;
export const APPLICATION_SPLASH_WORDMARK_GLITCH_INTERVAL_MS = 42;

export const APPLICATION_SPLASH_BOLT_GLITCH_CONFIG: EliteRevealConfig = {
  ...DEFAULT_ELITE_REVEAL_CONFIG,
  glitchCountMax: 3,
  glitchCountMin: 3,
  glitchShowMs: 16,
  staggerSpreadMs: 0,
  variants: ["chromatic", "spatial-shift"],
  variantWeights: {
    ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
    chromatic: 2,
    "spatial-shift": 2,
  },
};

export const APPLICATION_SPLASH_WORDMARK_GLITCH_CONFIG: EliteRevealConfig = {
  ...DEFAULT_ELITE_REVEAL_CONFIG,
  glitchCountMax: 3,
  glitchCountMin: 3,
  glitchShowMs: 14,
  staggerSpreadMs: 0,
  variants: ["chromatic", "spatial-shift", "text-jitter"],
  variantWeights: {
    ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
    chromatic: 2,
    "spatial-shift": 2,
    "text-jitter": 2,
  },
};

function useSplashGlitchReplay(intervalMs: number): number {
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = window.setInterval(
      () => setReplayKey((current) => current + 1),
      intervalMs,
    );
    return () => window.clearInterval(interval);
  }, [intervalMs]);

  return replayKey;
}

export function ApplicationLoadingSplash() {
  const boltReplayKey = useSplashGlitchReplay(
    APPLICATION_SPLASH_BOLT_GLITCH_INTERVAL_MS,
  );
  const wordmarkReplayKey = useSplashGlitchReplay(
    APPLICATION_SPLASH_WORDMARK_GLITCH_INTERVAL_MS,
  );

  return (
    <>
      <SessionWindowDragRegion enabled={isMacosDesktopRuntime()} />
      <main
        className="application-loading-splash"
        data-application-loading-splash=""
      >
        <div className="application-loading-splash__brand">
          <EliteReveal
            className="application-loading-splash__logo"
            config={APPLICATION_SPLASH_BOLT_GLITCH_CONFIG}
            contentKind="box"
            replayKey={boltReplayKey}
          >
            <span
              aria-hidden="true"
              className="application-loading-splash__mark"
            />
          </EliteReveal>
          <EliteReveal
            className="application-loading-splash__wordmark"
            config={APPLICATION_SPLASH_WORDMARK_GLITCH_CONFIG}
            contentKind="text"
            replayKey={wordmarkReplayKey}
          >
            <h1 className="application-loading-splash__name">Cantrip</h1>
          </EliteReveal>
        </div>
      </main>
    </>
  );
}
