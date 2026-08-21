import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import "./elite-reveal.css";

export const ELITE_GLITCH_VARIANTS = [
  "outline",
  "full-frame",
  "left-frame",
  "right-frame",
  "chromatic",
  "noise",
  "scanline",
  "text-jitter",
] as const;

export type EliteGlitchVariant = (typeof ELITE_GLITCH_VARIANTS)[number];
export type EliteRevealContentKind = "box" | "control" | "text";

export interface EliteRevealConfig {
  glitchCountMax: number;
  glitchCountMin: number;
  glitchShowMs: number;
  staggerDelayMs: number;
  variants: readonly EliteGlitchVariant[];
}

export const DEFAULT_ELITE_REVEAL_CONFIG: EliteRevealConfig = {
  glitchCountMax: 3,
  glitchCountMin: 1,
  glitchShowMs: 15,
  staggerDelayMs: 25,
  variants: ELITE_GLITCH_VARIANTS,
};

const numericLimits = {
  glitchCount: { max: 8, min: 1 },
  glitchShowMs: { max: 120, min: 5 },
  staggerDelayMs: { max: 250, min: 0 },
} as const;

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function normalizeEliteRevealConfig(
  config: EliteRevealConfig,
): EliteRevealConfig {
  const glitchCountMin = clamp(
    config.glitchCountMin,
    numericLimits.glitchCount.min,
    numericLimits.glitchCount.max,
  );
  const glitchCountMax = clamp(
    config.glitchCountMax,
    glitchCountMin,
    numericLimits.glitchCount.max,
  );
  return {
    glitchCountMax,
    glitchCountMin,
    glitchShowMs: clamp(
      config.glitchShowMs,
      numericLimits.glitchShowMs.min,
      numericLimits.glitchShowMs.max,
    ),
    staggerDelayMs: clamp(
      config.staggerDelayMs,
      numericLimits.staggerDelayMs.min,
      numericLimits.staggerDelayMs.max,
    ),
    variants: [...new Set(config.variants)].filter((variant) =>
      ELITE_GLITCH_VARIANTS.includes(variant),
    ),
  };
}

export function variantsForEliteContent(
  variants: readonly EliteGlitchVariant[],
  contentKind: EliteRevealContentKind,
): readonly EliteGlitchVariant[] {
  return variants.filter(
    (variant) => variant !== "text-jitter" || contentKind === "text",
  );
}

export function createEliteGlitchSequence(
  config: EliteRevealConfig,
  contentKind: EliteRevealContentKind,
  random: () => number = Math.random,
): readonly EliteGlitchVariant[] {
  const normalized = normalizeEliteRevealConfig(config);
  const variants = variantsForEliteContent(normalized.variants, contentKind);
  const fallbackVariant = variants[0];
  if (!fallbackVariant) return [];
  const countRange = normalized.glitchCountMax - normalized.glitchCountMin + 1;
  const count =
    normalized.glitchCountMin +
    Math.min(countRange - 1, Math.floor(random() * countRange));
  return Array.from({ length: count }, () => {
    const index = Math.min(
      variants.length - 1,
      Math.floor(random() * variants.length),
    );
    return variants[index] ?? fallbackVariant;
  });
}

type RevealStage =
  | { state: "glitch"; variant: EliteGlitchVariant }
  | { state: "ready" | "waiting"; variant: null };

export function EliteReveal({
  children,
  className,
  config,
  contentKind = "box",
  index = 0,
  replayKey,
}: {
  children: ReactNode;
  className?: string;
  config: EliteRevealConfig;
  contentKind?: EliteRevealContentKind;
  index?: number;
  replayKey: number;
}) {
  const normalized = useMemo(
    () => normalizeEliteRevealConfig(config),
    [
      config.glitchCountMax,
      config.glitchCountMin,
      config.glitchShowMs,
      config.staggerDelayMs,
      config.variants,
    ],
  );
  const configSignature = `${normalized.glitchCountMin}:${normalized.glitchCountMax}:${normalized.glitchShowMs}:${normalized.staggerDelayMs}:${normalized.variants.join(",")}`;
  const [stage, setStage] = useState<RevealStage>(() =>
    variantsForEliteContent(normalized.variants, contentKind).length
      ? { state: "waiting", variant: null }
      : { state: "ready", variant: null },
  );

  useEffect(() => {
    const sequence = createEliteGlitchSequence(normalized, contentKind);
    if (!sequence.length) {
      setStage({ state: "ready", variant: null });
      return;
    }

    const timers = new Set<number>();
    let cancelled = false;
    const schedule = (callback: () => void, delayMs: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (!cancelled) callback();
      }, delayMs);
      timers.add(timer);
    };
    const interGlitchGapMs = Math.max(
      6,
      Math.round(normalized.glitchShowMs * 0.65),
    );
    let sequenceIndex = 0;
    const showNextGlitch = () => {
      const variant = sequence[sequenceIndex];
      if (!variant) {
        setStage({ state: "ready", variant: null });
        return;
      }
      setStage({ state: "glitch", variant });
      schedule(() => {
        sequenceIndex += 1;
        setStage({ state: "waiting", variant: null });
        schedule(showNextGlitch, interGlitchGapMs);
      }, normalized.glitchShowMs);
    };

    setStage({ state: "waiting", variant: null });
    schedule(showNextGlitch, Math.max(0, index) * normalized.staggerDelayMs);
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [configSignature, contentKind, index, normalized, replayKey]);

  return (
    <div
      className={cn("elite-reveal", className)}
      data-content-kind={contentKind}
      data-elite-reveal=""
      data-state={stage.state}
      data-variant={stage.variant ?? undefined}
    >
      <div className="elite-reveal__content">{children}</div>
      <span aria-hidden="true" className="elite-reveal__signal" />
    </div>
  );
}
