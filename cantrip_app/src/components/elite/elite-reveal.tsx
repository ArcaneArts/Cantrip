import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

import "./elite-reveal.css";

export const ELITE_GLITCH_VARIANTS = [
  "outline",
  "full-frame",
  "left-frame",
  "right-frame",
  "chromatic",
  "spatial-shift",
  "pixelate",
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
  glitchShowMs: 9,
  staggerDelayMs: 7,
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

export interface EliteGlitchFrame {
  chromaticAngleDeg: number;
  chromaticDistancePx: number;
  chromaticOffsetXPx: number;
  chromaticOffsetYPx: number;
  pixelOffsetXPx: number;
  pixelOffsetYPx: number;
  pixelSizePx: number;
  shiftXPercent: number;
  shiftYPercent: number;
  variant: EliteGlitchVariant;
}

function unitRandom(random: () => number): number {
  return Math.min(0.999_999, Math.max(0, random()));
}

function roundFrameValue(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function createEliteGlitchFrame(
  variant: EliteGlitchVariant,
  random: () => number = Math.random,
): EliteGlitchFrame {
  const frame: EliteGlitchFrame = {
    chromaticAngleDeg: 0,
    chromaticDistancePx: 0,
    chromaticOffsetXPx: 0,
    chromaticOffsetYPx: 0,
    pixelOffsetXPx: 0,
    pixelOffsetYPx: 0,
    pixelSizePx: 6,
    shiftXPercent: 0,
    shiftYPercent: 0,
    variant,
  };

  if (variant === "chromatic") {
    const angleDegrees = unitRandom(random) * 360;
    const distancePixels = 1 + unitRandom(random) * 5;
    const angleRadians = (angleDegrees * Math.PI) / 180;
    frame.chromaticAngleDeg = roundFrameValue(angleDegrees);
    frame.chromaticDistancePx = roundFrameValue(distancePixels);
    frame.chromaticOffsetXPx = roundFrameValue(
      Math.cos(angleRadians) * distancePixels,
    );
    frame.chromaticOffsetYPx = roundFrameValue(
      Math.sin(angleRadians) * distancePixels,
    );
  } else if (variant === "spatial-shift") {
    const angleRadians = unitRandom(random) * Math.PI * 2;
    const distancePercent = unitRandom(random) * 15;
    frame.shiftXPercent = roundFrameValue(
      Math.cos(angleRadians) * distancePercent,
    );
    frame.shiftYPercent = roundFrameValue(
      Math.sin(angleRadians) * distancePercent,
    );
  } else if (variant === "pixelate") {
    const pixelSize = 4 + Math.floor(unitRandom(random) * 9);
    frame.pixelSizePx = pixelSize;
    frame.pixelOffsetXPx = roundFrameValue(
      (unitRandom(random) * 2 - 1) * pixelSize,
    );
    frame.pixelOffsetYPx = roundFrameValue(
      (unitRandom(random) * 2 - 1) * pixelSize,
    );
  }

  return frame;
}

type RevealStage =
  | { frame: EliteGlitchFrame; state: "glitch" }
  | { frame: null; state: "armed" | "ready" | "waiting" };

type EliteRevealStyle = CSSProperties & {
  [property: `--elite-${string}`]: string;
};

interface PendingEliteRevealStart {
  active: boolean;
  index: number;
  start(staggerSlot: number): void;
}

const pendingEliteRevealStarts = new Set<PendingEliteRevealStart>();
let pendingEliteRevealFrame: number | null = null;

function queueEliteRevealStart(
  index: number,
  start: (staggerSlot: number) => void,
): () => void {
  const pending: PendingEliteRevealStart = { active: true, index, start };
  pendingEliteRevealStarts.add(pending);
  pendingEliteRevealFrame ??= window.requestAnimationFrame(() => {
    const starts = [...pendingEliteRevealStarts]
      .filter((candidate) => candidate.active)
      .sort((left, right) => left.index - right.index);
    pendingEliteRevealStarts.clear();
    pendingEliteRevealFrame = null;
    starts.forEach((candidate, staggerSlot) => candidate.start(staggerSlot));
  });

  return () => {
    pending.active = false;
    pendingEliteRevealStarts.delete(pending);
    if (!pendingEliteRevealStarts.size && pendingEliteRevealFrame !== null) {
      window.cancelAnimationFrame(pendingEliteRevealFrame);
      pendingEliteRevealFrame = null;
    }
  };
}

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
  const elementRef = useRef<HTMLDivElement>(null);
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
      ? { frame: null, state: "armed" }
      : { frame: null, state: "ready" },
  );

  useEffect(() => {
    const sequence = createEliteGlitchSequence(normalized, contentKind);
    if (!sequence.length) {
      setStage({ frame: null, state: "ready" });
      return;
    }

    const timers = new Set<number>();
    let cancelled = false;
    let cancelQueuedStart = () => {};
    let observer: IntersectionObserver | null = null;
    let started = false;
    const schedule = (callback: () => void, delayMs: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (!cancelled) callback();
      }, delayMs);
      timers.add(timer);
    };
    let sequenceIndex = 0;
    const showNextGlitch = () => {
      const variant = sequence[sequenceIndex];
      if (!variant) {
        setStage({ frame: null, state: "ready" });
        return;
      }
      setStage({ frame: createEliteGlitchFrame(variant), state: "glitch" });
      schedule(() => {
        sequenceIndex += 1;
        showNextGlitch();
      }, normalized.glitchShowMs);
    };
    const startWhenVisible = () => {
      if (started) return;
      started = true;
      observer?.disconnect();
      setStage({ frame: null, state: "waiting" });
      cancelQueuedStart = queueEliteRevealStart(index, (staggerSlot) =>
        schedule(showNextGlitch, staggerSlot * normalized.staggerDelayMs),
      );
    };

    setStage({ frame: null, state: "armed" });
    const element = elementRef.current;
    observer =
      element && "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              if (
                entries.some(
                  (entry) =>
                    entry.target === element &&
                    entry.isIntersecting &&
                    entry.intersectionRatio > 0,
                )
              ) {
                startWhenVisible();
              }
            },
            { threshold: 0.01 },
          )
        : null;

    if (observer && element) observer.observe(element);
    else startWhenVisible();

    return () => {
      cancelled = true;
      cancelQueuedStart();
      observer?.disconnect();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [configSignature, contentKind, index, normalized, replayKey]);

  const frame = stage.state === "glitch" ? stage.frame : null;
  const frameStyle: EliteRevealStyle | undefined = frame
    ? {
        "--elite-chromatic-angle": `${frame.chromaticAngleDeg}deg`,
        "--elite-chromatic-distance": `${frame.chromaticDistancePx}px`,
        "--elite-chromatic-x": `${frame.chromaticOffsetXPx}px`,
        "--elite-chromatic-x-negative": `${-frame.chromaticOffsetXPx}px`,
        "--elite-chromatic-y": `${frame.chromaticOffsetYPx}px`,
        "--elite-chromatic-y-negative": `${-frame.chromaticOffsetYPx}px`,
        "--elite-pixel-offset-x": `${frame.pixelOffsetXPx}px`,
        "--elite-pixel-offset-y": `${frame.pixelOffsetYPx}px`,
        "--elite-pixel-size": `${frame.pixelSizePx}px`,
        "--elite-shift-x": `${frame.shiftXPercent}%`,
        "--elite-shift-y": `${frame.shiftYPercent}%`,
      }
    : undefined;

  return (
    <div
      className={cn("elite-reveal", className)}
      data-content-kind={contentKind}
      data-elite-reveal=""
      data-state={stage.state}
      data-variant={frame?.variant}
      ref={elementRef}
      style={frameStyle}
    >
      <div className="elite-reveal__content">{children}</div>
      <span aria-hidden="true" className="elite-reveal__signal" />
    </div>
  );
}
