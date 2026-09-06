import { describe, expect, it } from "vitest";
import { cuaInputCommandSchema } from "./types.js";
import { cuaJavascriptActionSchema } from "./javascript.js";
import { matchesInputReceipt } from "./input-receipt.js";

describe("bounded native macros", () => {
  it("accepts Unicode text, chords and default 200 ms drag without caller authority", () => {
    expect(
      cuaInputCommandSchema.parse({ kind: "text", text: "Hello 🦀\n" }).kind,
    ).toBe("text");
    expect(cuaInputCommandSchema.parse({ kind: "key", key: "Enter" })).toEqual({
      kind: "key",
      key: "Enter",
      modifiers: [],
    });
    expect(
      cuaInputCommandSchema.parse({
        kind: "drag",
        start: { x: 1, y: 2 },
        end: { x: 20, y: 30 },
      }),
    ).toMatchObject({ durationMs: 200 });
    expect(
      cuaInputCommandSchema.parse({
        kind: "key",
        key: "A",
        modifiers: ["Meta"],
      }).kind,
    ).toBe("key");
    expect(
      cuaInputCommandSchema.parse({ kind: "scroll", deltaY: 300 }),
    ).toEqual({ kind: "scroll", deltaY: 300, deltaX: 0 });
  });
  it.each([
    { kind: "text", text: "🦀".repeat(2049) },
    { kind: "text", text: "\ud800" },
    { kind: "text", text: "\0" },
    { kind: "key", key: "Enter", modifiers: ["Meta", "Meta"] },
    { kind: "key", key: "not-a-key" },
    {
      kind: "drag",
      start: { x: 1, y: 2 },
      end: { x: 3, y: 4 },
      durationMs: 100000,
    },
    { kind: "scroll", deltaY: Infinity },
    { kind: "scroll", deltaY: 1, processId: 777 },
  ])("rejects malformed or unbounded command %j", (command) => {
    expect(cuaInputCommandSchema.safeParse(command).success).toBe(false);
  });
  it("does not permit redirected authority, held keys or implicit fallback", () => {
    for (const extra of [
      { binding: {} },
      { targetId: "another" },
      { fallback: true },
      { globalInput: true },
    ]) {
      expect(
        cuaJavascriptActionSchema.safeParse({
          operation: "perform",
          command: { kind: "key", key: "Enter" },
          ...extra,
        }).success,
      ).toBe(false);
    }
    expect(
      cuaInputCommandSchema.safeParse({ kind: "key", key: "Enter", down: true })
        .success,
    ).toBe(false);
  });
  it("bounds explicit delays", () => {
    expect(
      cuaJavascriptActionSchema.parse({ operation: "wait", ms: 150 }),
    ).toEqual({ operation: "wait", ms: 150 });
    for (const ms of [-1, 0.1, 10001, Infinity])
      expect(
        cuaJavascriptActionSchema.safeParse({ operation: "wait", ms }).success,
      ).toBe(false);
  });
  it.each([
    "background-text",
    "background-key",
    "background-drag",
    "background-scroll",
  ] as const)("never upgrades a %s receipt to verified dispatch", (method) => {
    const receipt = {
      method,
      activation: false,
      outcome: "unknown" as const,
      windowDelivery: "unverified" as const,
      position: { x: 2, y: 3 },
      globalPosition: { x: 12, y: 13 },
    };
    expect(matchesInputReceipt(receipt, method, { x: 2, y: 3 })).toBe(true);
    expect(
      matchesInputReceipt({ ...receipt, outcome: "dispatched" }, method),
    ).toBe(false);
    expect(matchesInputReceipt(receipt, method, { x: 3, y: 4 })).toBe(false);
  });
});
