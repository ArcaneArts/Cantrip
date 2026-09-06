import { encodeCuaFrame } from "./framing.js";
import { cuaMcpScriptSchema } from "../mcp/cua-contract.js";
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

describe("native chord timeline", () => {
  const parse = (frames: unknown) =>
    cuaInputCommandSchema.safeParse({ kind: "timeline", frames });
  it("supports chords, overlap and re-articulation in one frame", () => {
    expect(
      parse([
        { atMs: 0, keyDown: ["C", "B"] },
        { atMs: 100, keyUp: ["C"], keyDown: ["C", "M"] },
        { atMs: 500, keyUp: ["C", "B", "M"] },
      ]).success,
    ).toBe(true);
    expect(
      parse([
        { atMs: 0, pointerDown: { x: 10, y: 20 } },
        { atMs: 150, pointerUp: true },
      ]).success,
    ).toBe(true);
  });
  it.each(
    [
      [{ atMs: 0, keyDown: ["C"] }],
      [{ atMs: 0, keyUp: ["C"] }],
      [{ atMs: 0, keyDown: ["C", "C"] }],
      [{ atMs: 100 }, { atMs: 0 }],
      [{ atMs: 7200001 }],
      [{ atMs: 0, pointerDown: { x: 1, y: 1 } }],
      [{ atMs: 0, pointerUp: true }],
      [{ atMs: 0, keyDown: ["Bogus"] }],
      [{ atMs: 0, globalInput: true }],
    ].map((frames) => ({ frames })),
  )("rejects invalid held-state or timing %j", ({ frames }) =>
    expect(parse(frames).success).toBe(false),
  );
});

describe("explicit pointer modifiers", () => {
  it("carries Command on the mouse down while leaving the matching release implicit", () => {
    const command = cuaInputCommandSchema.parse({
      kind: "timeline",
      frames: [
        {
          atMs: 0,
          pointerDown: { x: 10, y: 20 },
          pointerModifiers: ["Meta"],
          keyDown: ["C"],
        },
        { atMs: 150, pointerUp: true, keyUp: ["C"] },
      ],
    });
    expect(command).toMatchObject({
      frames: [{ pointerModifiers: ["Meta"] }, { pointerModifiers: [] }],
    });
  });
  it.each(
    [
      [{ atMs: 0, pointerModifiers: ["Meta"] }],
      [
        {
          atMs: 0,
          pointerDown: { x: 10, y: 20 },
          pointerModifiers: ["Meta", "Meta"],
        },
        { atMs: 150, pointerUp: true },
      ],
      [
        {
          atMs: 0,
          pointerDown: { x: 10, y: 20 },
          pointerModifiers: ["Command"],
        },
        { atMs: 150, pointerUp: true },
      ],
      [
        { atMs: 0, pointerDown: { x: 10, y: 20 } },
        { atMs: 150, pointerUp: true, pointerModifiers: ["Meta"] },
      ],
    ].map((frames) => ({ frames })),
  )("rejects ambiguous or unsupported modifier state %j", ({ frames }) => {
    expect(
      cuaInputCommandSchema.safeParse({ kind: "timeline", frames }).success,
    ).toBe(false);
  });
});

describe("focus and full performance contracts", () => {
  it("accepts explicit focus and requires an activation receipt", () => {
    expect(
      cuaJavascriptActionSchema.parse({
        operation: "perform",
        command: { kind: "focus" },
      }),
    ).toEqual({ operation: "perform", command: { kind: "focus" } });
    expect(
      matchesInputReceipt(
        { method: "focus", activation: true, outcome: "dispatched" },
        "focus",
      ),
    ).toBe(true);
    expect(
      matchesInputReceipt(
        { method: "focus", activation: false, outcome: "dispatched" },
        "focus",
      ),
    ).toBe(false);
  });
  it("accepts a two-hour score with 131072 frames in the actual wire envelope", () => {
    const frames = Array.from({ length: 131072 }, (_, i) =>
      i % 2 === 0
        ? { atMs: i * 50, keyDown: ["C"] }
        : { atMs: i * 50, keyUp: ["C"] },
    );
    frames.at(-1)!.atMs = 7200000;
    const action = cuaJavascriptActionSchema.parse({
      operation: "perform",
      command: { kind: "timeline", frames },
    });
    const encoded = encodeCuaFrame({
      version: 1,
      message: { kind: "request", requestId: 1, operation: action },
    });
    expect(encoded.byteLength).toBeGreaterThan(1024 * 1024);
    expect(
      cuaInputCommandSchema.safeParse({
        kind: "timeline",
        frames: [...frames, { atMs: 7200000 }],
      }).success,
    ).toBe(false);
    expect(
      cuaInputCommandSchema.safeParse({
        kind: "timeline",
        frames: [{ atMs: 7200001 }],
      }).success,
    ).toBe(false);
  });
  it("accepts larger UTF-8 scripts through the MCP schema", () => {
    expect(
      cuaMcpScriptSchema.safeParse("x".repeat(2 * 1024 * 1024)).success,
    ).toBe(true);
    expect(cuaMcpScriptSchema.safeParse("😀".repeat(524289)).success).toBe(
      false,
    );
  });
});

describe("target-only AppKit preparation", () => {
  it("exposes a parameterless authorized input command, with honest activation metadata", () => {
    expect(
      cuaJavascriptActionSchema.parse({
        operation: "perform",
        command: { kind: "window-input" },
      }),
    ).toEqual({ operation: "perform", command: { kind: "window-input" } });
    expect(
      cuaJavascriptActionSchema.safeParse({
        operation: "perform",
        command: { kind: "window-input", pid: 1 },
      }).success,
    ).toBe(false);
    expect(
      matchesInputReceipt(
        { method: "window-input", activation: true, outcome: "dispatched" },
        "window-input",
      ),
    ).toBe(true);
    expect(
      matchesInputReceipt(
        { method: "window-input", activation: false, outcome: "dispatched" },
        "window-input",
      ),
    ).toBe(false);
    expect(
      matchesInputReceipt(
        { method: "focus", activation: true, outcome: "dispatched" },
        "window-input",
      ),
    ).toBe(false);
  });
});
