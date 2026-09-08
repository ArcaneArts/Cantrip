import { describe, expect, it } from "vitest";
import { ManagedGuiPreparationRegistry } from "../src/codex/managed-gui-preparation.js";

const root = { operationId: "root", operationGeneration: "generation" };
describe("exact GUI preparation cancellation", () => {
  it("retains Stop received before preparation registers", () => {
    const registry = new ManagedGuiPreparationRegistry();
    registry.cancel("chat", root);
    expect(registry.signal("chat", root).aborted).toBe(true);
  });

  it("cannot cancel or release a newer root or another chat", () => {
    const registry = new ManagedGuiPreparationRegistry();
    const next = {
      operationId: "next",
      operationGeneration: "next-generation",
    };
    const oldSignal = registry.signal("chat", root);
    const newSignal = registry.signal("chat", next);
    const otherSignal = registry.signal("other-chat", root);
    registry.cancel("chat", root);
    registry.complete("chat", root);
    expect(oldSignal.aborted).toBe(true);
    expect(registry.signal("chat", next)).toBe(newSignal);
    expect(newSignal.aborted).toBe(false);
    expect(otherSignal.aborted).toBe(false);
  });

  it("revokes old preparations on terminal bridge loss without reviving their signals", () => {
    const registry = new ManagedGuiPreparationRegistry();
    const signal = registry.signal("chat", root);
    registry.disconnect();
    const next = registry.signal("chat", {
      operationId: "next",
      operationGeneration: "next",
    });
    expect(signal.aborted).toBe(true);
    expect(next.aborted).toBe(false);
  });
});
