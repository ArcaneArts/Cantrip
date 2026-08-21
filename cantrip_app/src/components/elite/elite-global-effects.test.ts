import { describe, expect, it } from "vitest";

import {
  ELITE_GLOBAL_CANDIDATE_SELECTOR,
  isEligibleEliteGlobalElement,
  shouldAnimateEliteGlobalElement,
} from "./elite-global-effects";

function trackedElement(stableKey?: string, isConnected = true): HTMLElement {
  return {
    dataset: stableKey ? { eliteGlobalKey: stableKey } : {},
    isConnected,
  } as unknown as HTMLElement;
}

describe("Elite global effects", () => {
  it("targets semantic component boundaries instead of every DOM node", () => {
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).toContain('[data-slot="card"]');
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).toContain(
      '[data-slot="dialog-content"]',
    );
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).toContain("button");
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).toContain('[role="row"]');
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).toContain(
      "[data-elite-global-key]",
    );
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).not.toContain("div,");
    expect(ELITE_GLOBAL_CANDIDATE_SELECTOR).not.toContain("span,");
  });

  it("reveals a stable semantic key only once across DOM replacements", () => {
    const animated = new WeakSet<HTMLElement>();
    const seenKeys = new Set<string>();
    const original = trackedElement("chat-message:chat-1:message-1");
    const replacement = trackedElement("chat-message:chat-1:message-1");

    expect(
      shouldAnimateEliteGlobalElement(original, animated, seenKeys, false),
    ).toBe(true);
    expect(
      shouldAnimateEliteGlobalElement(original, animated, seenKeys, false),
    ).toBe(false);
    expect(
      shouldAnimateEliteGlobalElement(replacement, animated, seenKeys, false),
    ).toBe(false);
  });

  it("consumes unkeyed scroll churn without suppressing genuinely new keyed UI", () => {
    const animated = new WeakSet<HTMLElement>();
    const seenKeys = new Set<string>();
    const scrollChurn = trackedElement();
    const newMessage = trackedElement("chat-message:chat-1:message-2");

    expect(
      shouldAnimateEliteGlobalElement(scrollChurn, animated, seenKeys, true),
    ).toBe(false);
    expect(
      shouldAnimateEliteGlobalElement(scrollChurn, animated, seenKeys, false),
    ).toBe(false);
    expect(
      shouldAnimateEliteGlobalElement(newMessage, animated, seenKeys, true),
    ).toBe(true);
  });

  it("treats keyed reveal boundaries as stable scopes", () => {
    const boundary = {
      closest: () => null,
      parentElement: null,
    } as unknown as HTMLElement;
    const nestedUpdate = {
      closest: () => null,
      parentElement: {
        closest: (selector: string) =>
          selector === "[data-elite-global-key]" ? boundary : null,
      },
    } as unknown as HTMLElement;
    const ignored = {
      closest: () => boundary,
      parentElement: null,
    } as unknown as HTMLElement;

    expect(isEligibleEliteGlobalElement(boundary)).toBe(true);
    expect(isEligibleEliteGlobalElement(nestedUpdate)).toBe(false);
    expect(isEligibleEliteGlobalElement(ignored)).toBe(false);
  });
});
