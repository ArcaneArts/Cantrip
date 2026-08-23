import {
  DEFAULT_ELITE_GLITCH_VARIANT_WEIGHTS,
  DEFAULT_ELITE_REVEAL_CONFIG as PROTOCOL_DEFAULT_ELITE_REVEAL_CONFIG,
  eliteGlitchVariantSchema,
  MAX_ELITE_GLITCH_COUNT,
  type EliteGlitchVariant,
  type EliteGlitchVariantWeights,
  type EliteRevealConfig,
} from "@cantrip/protocol";
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

export const ELITE_GLITCH_VARIANTS = eliteGlitchVariantSchema.options;
export { MAX_ELITE_GLITCH_COUNT };
export type { EliteGlitchVariant, EliteRevealConfig } from "@cantrip/protocol";
export type EliteRevealContentKind = "box" | "control" | "text";

export const ELITE_GLITCH_VARIANT_WEIGHTS =
  DEFAULT_ELITE_GLITCH_VARIANT_WEIGHTS;

export const ELITE_CHROMATIC_PAIRS = [
  { channelA: "rgb(0 224 255)", channelB: "rgb(255 34 122)" },
  { channelA: "rgb(76 125 255)", channelB: "rgb(255 150 42)" },
  { channelA: "rgb(188 88 255)", channelB: "rgb(102 255 68)" },
  { channelA: "rgb(255 58 78)", channelB: "rgb(38 244 207)" },
  { channelA: "rgb(255 220 64)", channelB: "rgb(92 84 255)" },
] as const;

export const DEFAULT_ELITE_REVEAL_CONFIG = PROTOCOL_DEFAULT_ELITE_REVEAL_CONFIG;

const numericLimits = {
  glitchCount: { max: MAX_ELITE_GLITCH_COUNT, min: 1 },
  glitchShowMs: { max: 120, min: 5 },
  staggerSpreadMs: { max: 250, min: 0 },
  variantWeight: { max: 10, min: 0 },
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
    glitchTerminalContents: config.glitchTerminalContents,
    glitchCountMax,
    glitchCountMin,
    glitchShowMs: clamp(
      config.glitchShowMs,
      numericLimits.glitchShowMs.min,
      numericLimits.glitchShowMs.max,
    ),
    staggerSpreadMs: clamp(
      config.staggerSpreadMs,
      numericLimits.staggerSpreadMs.min,
      numericLimits.staggerSpreadMs.max,
    ),
    variants: [...new Set(config.variants)].filter((variant) =>
      ELITE_GLITCH_VARIANTS.includes(variant),
    ),
    variantWeights: Object.fromEntries(
      ELITE_GLITCH_VARIANTS.map((variant) => [
        variant,
        Math.min(
          numericLimits.variantWeight.max,
          Math.max(
            numericLimits.variantWeight.min,
            config.variantWeights[variant],
          ),
        ),
      ]),
    ) as EliteGlitchVariantWeights,
  };
}

export function eliteRevealConfigSignature(config: EliteRevealConfig): string {
  const weightSignature = ELITE_GLITCH_VARIANTS.map(
    (variant) => config.variantWeights[variant],
  ).join(",");
  return `${Number(config.glitchTerminalContents)}:${config.glitchCountMin}:${config.glitchCountMax}:${config.glitchShowMs}:${config.staggerSpreadMs}:${config.variants.join(",")}:${weightSignature}`;
}

export function variantsForEliteContent(
  variants: readonly EliteGlitchVariant[],
  contentKind: EliteRevealContentKind,
): readonly EliteGlitchVariant[] {
  return variants.filter(
    (variant) => variant !== "text-jitter" || contentKind === "text",
  );
}

export function selectEliteGlitchVariant(
  variants: readonly EliteGlitchVariant[],
  variantWeights: EliteGlitchVariantWeights,
  random: () => number = Math.random,
): EliteGlitchVariant | undefined {
  const weightedVariants = variants.filter(
    (variant) => variantWeights[variant] > 0,
  );
  const fallbackVariant = weightedVariants.at(-1);
  if (!fallbackVariant) return undefined;

  const totalWeight = weightedVariants.reduce(
    (total, variant) => total + variantWeights[variant],
    0,
  );
  let selection = unitRandom(random) * totalWeight;
  for (const variant of weightedVariants) {
    const weight = variantWeights[variant];
    if (selection < weight) return variant;
    selection -= weight;
  }
  return fallbackVariant;
}

export function createEliteGlitchSequence(
  config: EliteRevealConfig,
  contentKind: EliteRevealContentKind,
  random: () => number = Math.random,
): readonly EliteGlitchVariant[] {
  const normalized = normalizeEliteRevealConfig(config);
  const variants = variantsForEliteContent(normalized.variants, contentKind);
  const fallbackVariant = variants.find(
    (variant) => normalized.variantWeights[variant] > 0,
  );
  if (!fallbackVariant) return [];
  const countRange = normalized.glitchCountMax - normalized.glitchCountMin + 1;
  const count =
    normalized.glitchCountMin +
    Math.min(countRange - 1, Math.floor(random() * countRange));
  return Array.from({ length: count }, () => {
    return (
      selectEliteGlitchVariant(variants, normalized.variantWeights, random) ??
      fallbackVariant
    );
  });
}

export function eliteStaggerDelayForVisibleRank(
  visibleIndex: number,
  visibleCount: number,
  spreadMs: number,
): number {
  const normalizedSpread = Math.max(0, Math.round(spreadMs));
  if (visibleIndex < 0) return normalizedSpread;
  if (visibleCount <= 1) return 0;
  const boundedIndex = Math.min(visibleCount - 1, Math.max(0, visibleIndex));
  return Math.round((boundedIndex / (visibleCount - 1)) * normalizedSpread);
}

export interface EliteGlitchFrame {
  chromaticAngleDeg: number;
  chromaticDistancePx: number;
  chromaticChannelA: string;
  chromaticChannelB: string;
  chromaticOffsetXPx: number;
  chromaticOffsetYPx: number;
  outlineBottom: boolean;
  outlineLeft: boolean;
  outlineRight: boolean;
  outlineTop: boolean;
  scanlineBands: readonly EliteScanlineBand[];
  scanlineSide: EliteScanlineSide;
  shiftXPercent: number;
  shiftYPercent: number;
  variant: EliteGlitchVariant;
}

export interface EliteScanlineBand {
  heightPx: number;
  topPercent: number;
}

export type EliteScanlineSide = "full" | "left" | "right";

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
  const defaultChromaticPair = ELITE_CHROMATIC_PAIRS[0];
  const frame: EliteGlitchFrame = {
    chromaticAngleDeg: 0,
    chromaticChannelA: defaultChromaticPair.channelA,
    chromaticChannelB: defaultChromaticPair.channelB,
    chromaticDistancePx: 0,
    chromaticOffsetXPx: 0,
    chromaticOffsetYPx: 0,
    outlineBottom: false,
    outlineLeft: false,
    outlineRight: false,
    outlineTop: false,
    scanlineBands: [],
    scanlineSide: "full",
    shiftXPercent: 0,
    shiftYPercent: 0,
    variant,
  };

  if (variant === "outline") {
    frame.outlineTop = unitRandom(random) >= 0.5;
    frame.outlineRight = unitRandom(random) >= 0.5;
    frame.outlineBottom = unitRandom(random) >= 0.5;
    frame.outlineLeft = unitRandom(random) >= 0.5;
    if (
      !frame.outlineTop &&
      !frame.outlineRight &&
      !frame.outlineBottom &&
      !frame.outlineLeft
    ) {
      frame.outlineTop = true;
    }
  } else if (variant === "chromatic") {
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
    const chromaticPair =
      ELITE_CHROMATIC_PAIRS[
        Math.floor(unitRandom(random) * ELITE_CHROMATIC_PAIRS.length)
      ] ?? defaultChromaticPair;
    frame.chromaticChannelA = chromaticPair.channelA;
    frame.chromaticChannelB = chromaticPair.channelB;
  } else if (variant === "spatial-shift") {
    const angleRadians = unitRandom(random) * Math.PI * 2;
    const distancePercent = unitRandom(random) * 7.5;
    frame.shiftXPercent = roundFrameValue(
      Math.cos(angleRadians) * distancePercent,
    );
    frame.shiftYPercent = roundFrameValue(
      Math.sin(angleRadians) * distancePercent,
    );
  } else if (variant === "scanline") {
    const bandCount = 1 + Math.floor(unitRandom(random) * 5);
    const sides: readonly EliteScanlineSide[] = ["full", "left", "right"];
    frame.scanlineSide =
      sides[Math.floor(unitRandom(random) * sides.length)] ?? "full";
    frame.scanlineBands = Array.from({ length: bandCount }, () => ({
      heightPx: 3 + Math.floor(unitRandom(random) * 8),
      topPercent: roundFrameValue(4 + unitRandom(random) * 92),
    }));
  }

  return frame;
}

type RevealStage =
  | { frame: EliteGlitchFrame; state: "glitch" }
  | { frame: null; state: "ready" | "waiting" };

export type EliteRevealStyle = CSSProperties & {
  [property: `--elite-${string}`]: string;
};

export function eliteGlitchFrameStyle(
  frame: EliteGlitchFrame,
): EliteRevealStyle {
  const scanlineBands = frame.scanlineBands.length
    ? frame.scanlineBands
        .map(
          (band) =>
            `linear-gradient(var(--elite-reveal-frame) 0 0) 0 ${band.topPercent}% / 100% ${band.heightPx}px no-repeat`,
        )
        .join(", ")
    : "none";
  const scanlineClip =
    frame.scanlineSide === "left"
      ? "inset(0 50% 0 0)"
      : frame.scanlineSide === "right"
        ? "inset(0 0 0 50%)"
        : "inset(0)";

  return {
    "--elite-chromatic-angle": `${frame.chromaticAngleDeg}deg`,
    "--elite-chromatic-channel-a": frame.chromaticChannelA,
    "--elite-chromatic-channel-b": frame.chromaticChannelB,
    "--elite-chromatic-distance": `${frame.chromaticDistancePx}px`,
    "--elite-chromatic-x": `${frame.chromaticOffsetXPx}px`,
    "--elite-chromatic-x-negative": `${-frame.chromaticOffsetXPx}px`,
    "--elite-chromatic-y": `${frame.chromaticOffsetYPx}px`,
    "--elite-chromatic-y-negative": `${-frame.chromaticOffsetYPx}px`,
    "--elite-outline-bottom": frame.outlineBottom ? "1px" : "0px",
    "--elite-outline-left": frame.outlineLeft ? "1px" : "0px",
    "--elite-outline-right": frame.outlineRight ? "1px" : "0px",
    "--elite-outline-top": frame.outlineTop ? "1px" : "0px",
    "--elite-scanline-bands": scanlineBands,
    "--elite-scanline-clip": scanlineClip,
    "--elite-shift-x": `${frame.shiftXPercent}%`,
    "--elite-shift-y": `${frame.shiftYPercent}%`,
  };
}

function clipsOverflow(value: string): boolean {
  return (
    value === "auto" ||
    value === "clip" ||
    value === "hidden" ||
    value === "scroll"
  );
}

export function isEliteRevealVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  let left = Math.max(0, rect.left);
  let right = Math.min(window.innerWidth, rect.right);
  let top = Math.max(0, rect.top);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  let ancestor = element.parentElement;

  while (ancestor && right > left && bottom > top) {
    const style = window.getComputedStyle(ancestor);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const ancestorRect = ancestor.getBoundingClientRect();
    if (clipsOverflow(style.overflowX)) {
      left = Math.max(left, ancestorRect.left);
      right = Math.min(right, ancestorRect.right);
    }
    if (clipsOverflow(style.overflowY)) {
      top = Math.max(top, ancestorRect.top);
      bottom = Math.min(bottom, ancestorRect.bottom);
    }
    ancestor = ancestor.parentElement;
  }

  return right > left && bottom > top;
}

interface EliteSpreadSnapshot {
  delays: ReadonlyMap<Element, number>;
  elements: ReadonlySet<Element>;
  spreadMs: number;
}

let eliteSpreadSnapshot: EliteSpreadSnapshot | null = null;
let eliteSpreadSnapshotClearQueued = false;

function staggerDelayForEliteElement(
  element: HTMLElement,
  spreadMs: number,
): number {
  if (
    !eliteSpreadSnapshot ||
    eliteSpreadSnapshot.spreadMs !== spreadMs ||
    !eliteSpreadSnapshot.elements.has(element)
  ) {
    const elements = [
      ...document.querySelectorAll<HTMLElement>("[data-elite-reveal]"),
    ];
    const visibleElements = elements
      .filter(isEliteRevealVisible)
      .map((candidate) => ({
        element: candidate,
        rect: candidate.getBoundingClientRect(),
      }))
      .sort((left, right) => {
        const verticalDifference = left.rect.top - right.rect.top;
        return Math.abs(verticalDifference) > 1
          ? verticalDifference
          : left.rect.left - right.rect.left;
      });
    const visibleRanks = new Map(
      visibleElements.map(({ element: candidate }, rank) => [candidate, rank]),
    );
    const delays = new Map(
      elements.map((candidate) => [
        candidate,
        eliteStaggerDelayForVisibleRank(
          visibleRanks.get(candidate) ?? -1,
          visibleElements.length,
          spreadMs,
        ),
      ]),
    );
    eliteSpreadSnapshot = {
      delays,
      elements: new Set(elements),
      spreadMs,
    };
    if (!eliteSpreadSnapshotClearQueued) {
      eliteSpreadSnapshotClearQueued = true;
      queueMicrotask(() => {
        eliteSpreadSnapshot = null;
        eliteSpreadSnapshotClearQueued = false;
      });
    }
  }

  return eliteSpreadSnapshot.delays.get(element) ?? spreadMs;
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
      config.glitchTerminalContents,
      config.glitchShowMs,
      config.staggerSpreadMs,
      config.variants,
      config.variantWeights,
    ],
  );
  const configSignature = eliteRevealConfigSignature(normalized);
  const [stage, setStage] = useState<RevealStage>(() =>
    variantsForEliteContent(normalized.variants, contentKind).some(
      (variant) => normalized.variantWeights[variant] > 0,
    )
      ? { frame: null, state: "waiting" }
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
    const schedule = (callback: () => void, delayMs: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (!cancelled) callback();
      }, delayMs);
      timers.add(timer);
    };
    setStage({ frame: null, state: "waiting" });
    const startDelayMs = elementRef.current
      ? staggerDelayForEliteElement(
          elementRef.current,
          normalized.staggerSpreadMs,
        )
      : eliteStaggerDelayForVisibleRank(
          index,
          Math.max(1, index + 1),
          normalized.staggerSpreadMs,
        );
    sequence.forEach((variant, sequenceIndex) => {
      schedule(
        () =>
          setStage({
            frame: createEliteGlitchFrame(variant),
            state: "glitch",
          }),
        startDelayMs + sequenceIndex * normalized.glitchShowMs,
      );
    });
    schedule(
      () => setStage({ frame: null, state: "ready" }),
      startDelayMs + sequence.length * normalized.glitchShowMs + 1,
    );

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [configSignature, contentKind, index, normalized, replayKey]);

  const frame = stage.state === "glitch" ? stage.frame : null;
  const frameStyle = frame ? eliteGlitchFrameStyle(frame) : undefined;

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
