import { useEffect, useMemo, useRef } from "react";

import {
  createEliteGlitchFrame,
  createEliteGlitchSequence,
  eliteGlitchFrameStyle,
  eliteStaggerDelayForVisibleRank,
  isEliteRevealVisible,
  normalizeEliteRevealConfig,
  type EliteRevealConfig,
  type EliteRevealContentKind,
} from "./elite-reveal";

import "./elite-global-effects.css";

export const ELITE_GLOBAL_CANDIDATE_SELECTOR = [
  "[data-elite-global]",
  '[data-slot="card"]',
  '[data-slot="dialog-content"]',
  '[data-slot="empty-state"]',
  '[data-slot="terminal-service-panel-surface"]',
  '[data-slot="agent-inspect-panel"]',
  '[data-slot="git-history-drawer"]',
  "button",
  "input",
  "textarea",
  "select",
  "a[href]",
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="row"]',
  "tbody > tr",
  "h1",
  "h2",
  "h3",
  "p",
].join(",");

const ELITE_GLOBAL_STYLE_PROPERTIES = [
  "--elite-chromatic-angle",
  "--elite-chromatic-channel-a",
  "--elite-chromatic-channel-b",
  "--elite-chromatic-distance",
  "--elite-chromatic-x",
  "--elite-chromatic-x-negative",
  "--elite-chromatic-y",
  "--elite-chromatic-y-negative",
  "--elite-outline-bottom",
  "--elite-outline-left",
  "--elite-outline-right",
  "--elite-outline-top",
  "--elite-scanline-bands",
  "--elite-scanline-clip",
  "--elite-shift-x",
  "--elite-shift-y",
] as const;

function eligibleEliteGlobalElement(element: HTMLElement): boolean {
  return !element.closest(
    "[data-elite-lab], [data-elite-ignore], [data-elite-reveal]",
  );
}

export function eliteGlobalContentKind(
  element: HTMLElement,
): EliteRevealContentKind {
  const tagName = element.tagName.toLowerCase();
  if (["h1", "h2", "h3", "p"].includes(tagName)) return "text";
  if (
    ["button", "input", "select", "textarea"].includes(tagName) ||
    element.matches(
      'a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"]',
    )
  ) {
    return "control";
  }
  return "box";
}

export function collectEliteGlobalCandidates(root: ParentNode): HTMLElement[] {
  const candidates = new Set<HTMLElement>();
  if (
    root instanceof HTMLElement &&
    root.matches(ELITE_GLOBAL_CANDIDATE_SELECTOR)
  ) {
    candidates.add(root);
  }
  root
    .querySelectorAll<HTMLElement>(ELITE_GLOBAL_CANDIDATE_SELECTOR)
    .forEach((element) => candidates.add(element));
  const eligible = [...candidates].filter(eligibleEliteGlobalElement);
  const eligibleSet = new Set(eligible);
  return eligible.filter((element) => {
    const parentCandidate = element.parentElement?.closest<HTMLElement>(
      ELITE_GLOBAL_CANDIDATE_SELECTOR,
    );
    return !parentCandidate || !eligibleSet.has(parentCandidate);
  });
}

function clearEliteGlobalFrameStyle(element: HTMLElement): void {
  ELITE_GLOBAL_STYLE_PROPERTIES.forEach((property) =>
    element.style.removeProperty(property),
  );
}

function settleEliteGlobalElement(element: HTMLElement): void {
  clearEliteGlobalFrameStyle(element);
  element.classList.remove("elite-global-effect");
  element.removeAttribute("data-elite-global-positioned");
  element.removeAttribute("data-elite-global-state");
  element.removeAttribute("data-elite-global-variant");
}

export function EliteGlobalEffects({
  config,
  enabled,
}: {
  config: EliteRevealConfig;
  enabled: boolean;
}) {
  const normalized = useMemo(
    () => normalizeEliteRevealConfig(config),
    [
      config.glitchCountMax,
      config.glitchCountMin,
      config.glitchShowMs,
      config.staggerSpreadMs,
      config.variants,
    ],
  );
  const configSignature = `${normalized.glitchCountMin}:${normalized.glitchCountMax}:${normalized.glitchShowMs}:${normalized.staggerSpreadMs}:${normalized.variants.join(",")}`;
  const normalizedRef = useRef(normalized);
  useEffect(() => {
    normalizedRef.current = normalized;
  }, [configSignature, normalized]);
  const hasVariants = normalized.variants.length > 0;

  useEffect(() => {
    if (!enabled || !hasVariants) return;

    const animated = new WeakSet<HTMLElement>();
    const active = new Set<HTMLElement>();
    const timers = new Map<HTMLElement, Set<number>>();
    let batchQueued = false;
    let cancelled = false;
    const pendingRoots = new Set<ParentNode>();

    const schedule = (
      element: HTMLElement,
      callback: () => void,
      delayMs: number,
    ) => {
      const elementTimers = timers.get(element) ?? new Set<number>();
      timers.set(element, elementTimers);
      const timer = window.setTimeout(() => {
        elementTimers.delete(timer);
        callback();
      }, delayMs);
      elementTimers.add(timer);
    };
    const settle = (element: HTMLElement) => {
      timers.get(element)?.forEach((timer) => window.clearTimeout(timer));
      timers.delete(element);
      active.delete(element);
      settleEliteGlobalElement(element);
    };
    const animateBatch = (elements: HTMLElement[]) => {
      if (cancelled) return;
      const fresh = elements.filter((element) => {
        if (animated.has(element) || !element.isConnected) return false;
        animated.add(element);
        return true;
      });
      const visible = fresh
        .filter(isEliteRevealVisible)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .sort((left, right) => {
          const verticalDifference = left.rect.top - right.rect.top;
          return Math.abs(verticalDifference) > 1
            ? verticalDifference
            : left.rect.left - right.rect.left;
        });
      const visibleRanks = new Map(
        visible.map(({ element }, rank) => [element, rank]),
      );

      fresh.forEach((element) => {
        const effectConfig = normalizedRef.current;
        const sequence = createEliteGlitchSequence(
          effectConfig,
          eliteGlobalContentKind(element),
        );
        if (!sequence.length) return;
        const startDelayMs = eliteStaggerDelayForVisibleRank(
          visibleRanks.get(element) ?? -1,
          visible.length,
          effectConfig.staggerSpreadMs,
        );
        active.add(element);
        element.classList.add("elite-global-effect");
        if (window.getComputedStyle(element).position === "static") {
          element.dataset.eliteGlobalPositioned = "";
        }
        element.dataset.eliteGlobalState = "waiting";

        sequence.forEach((variant, frameIndex) => {
          schedule(
            element,
            () => {
              if (!element.isConnected) {
                settle(element);
                return;
              }
              clearEliteGlobalFrameStyle(element);
              const frame = createEliteGlitchFrame(variant);
              Object.entries(eliteGlitchFrameStyle(frame)).forEach(
                ([property, value]) => {
                  if (value !== undefined && value !== null) {
                    element.style.setProperty(property, String(value));
                  }
                },
              );
              element.dataset.eliteGlobalState = "glitch";
              element.dataset.eliteGlobalVariant = variant;
            },
            startDelayMs + frameIndex * effectConfig.glitchShowMs,
          );
        });
        schedule(
          element,
          () => settle(element),
          startDelayMs + sequence.length * effectConfig.glitchShowMs + 1,
        );
      });
    };
    const flushBatch = () => {
      batchQueued = false;
      if (cancelled) return;
      const candidates = new Set<HTMLElement>();
      pendingRoots.forEach((root) => {
        collectEliteGlobalCandidates(root).forEach((element) =>
          candidates.add(element),
        );
      });
      pendingRoots.clear();
      animateBatch([...candidates]);
    };
    const queueRoot = (root: ParentNode) => {
      pendingRoots.add(root);
      if (batchQueued) return;
      batchQueued = true;
      queueMicrotask(flushBatch);
    };

    queueRoot(document.body);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) queueRoot(node);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelled = true;
      observer.disconnect();
      pendingRoots.clear();
      timers.forEach((elementTimers) =>
        elementTimers.forEach((timer) => window.clearTimeout(timer)),
      );
      active.forEach(settleEliteGlobalElement);
      timers.clear();
      active.clear();
    };
  }, [enabled, hasVariants]);

  return null;
}
