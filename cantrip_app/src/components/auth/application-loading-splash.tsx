import { useEffect, useState } from "react";

import { SessionWindowDragRegion } from "@/components/auth/session-window-drag-region";
import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  EliteReveal,
  type EliteRevealConfig,
} from "@cantrip/glitch";
import { isMacosDesktopRuntime } from "@/lib/desktop-popout";

import "./application-loading-splash.css";

export const APPLICATION_SPLASH_GLITCH_DELAY_MIN_MS = 1_000;
export const APPLICATION_SPLASH_GLITCH_DELAY_MAX_MS = 3_000;

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

export function applicationSplashGlitchDelayMs(
  random: () => number = Math.random,
): number {
  const value = random();
  const unit = Number.isFinite(value)
    ? Math.min(0.999_999, Math.max(0, value))
    : 0;
  return (
    APPLICATION_SPLASH_GLITCH_DELAY_MIN_MS +
    Math.floor(
      unit *
        (APPLICATION_SPLASH_GLITCH_DELAY_MAX_MS -
          APPLICATION_SPLASH_GLITCH_DELAY_MIN_MS +
          1),
    )
  );
}

function useSplashGlitchReplay(): number {
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timeout: number | undefined;
    const scheduleNext = () => {
      timeout = window.setTimeout(() => {
        setReplayKey((current) => current + 1);
        scheduleNext();
      }, applicationSplashGlitchDelayMs());
    };
    scheduleNext();
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, []);

  return replayKey;
}

export function ApplicationLoadingSplash() {
  const boltReplayKey = useSplashGlitchReplay();
  const wordmarkReplayKey = useSplashGlitchReplay();

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
