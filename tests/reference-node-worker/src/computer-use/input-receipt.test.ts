import { describe, expect, it } from "vitest";
import {
  inputRequestsPreparation,
  matchesInputReceipt,
} from "./input-receipt.js";
import { cuaInputCommandSchema, type CuaInputReceipt } from "./types.js";

const point = { x: 55, y: 797 };
const accessibility: CuaInputReceipt = {
  method: "accessibility",
  activation: false,
  outcome: "dispatched",
  position: point,
  globalPosition: { x: 1975, y: 827 },
};
describe("input receipt delivery validation", () => {
  it("accepts AX cursor clicks and reference presses without geometry", () => {
    expect(matchesInputReceipt(accessibility, "accessibility", point)).toBe(
      true,
    );
    expect(
      matchesInputReceipt(
        { method: "accessibility", activation: false, outcome: "dispatched" },
        "accessibility",
      ),
    ).toBe(true);
  });
  it("accepts explicit global and unverified process delivery", () => {
    expect(
      matchesInputReceipt(
        { ...accessibility, method: "coordinate" },
        "coordinate",
        point,
      ),
    ).toBe(true);
    expect(
      matchesInputReceipt(
        {
          ...accessibility,
          method: "process-coordinate",
          outcome: "unknown",
          windowDelivery: "unverified",
        },
        "process-coordinate",
        point,
      ),
    ).toBe(true);
  });
  it("rejects a different method, wrong point and false process certainty", () => {
    expect(
      matchesInputReceipt(
        { ...accessibility, method: "coordinate" },
        "accessibility",
        point,
      ),
    ).toBe(false);
    expect(
      matchesInputReceipt(accessibility, "accessibility", { x: 56, y: 797 }),
    ).toBe(false);
    expect(
      matchesInputReceipt(
        { ...accessibility, globalPosition: undefined },
        "accessibility",
        point,
      ),
    ).toBe(false);
    expect(
      matchesInputReceipt(
        { ...accessibility, method: "process-coordinate" },
        "process-coordinate",
        point,
      ),
    ).toBe(false);
  });
});

it("accepts completed background dispatch while requiring unverified window delivery", () => {
  const receipt = {
    method: "background-coordinate" as const,
    activation: false,
    outcome: "unknown" as const,
    windowDelivery: "unverified" as const,
    position: { x: 12, y: 15 },
    globalPosition: { x: 112, y: 215 },
  };
  expect(
    matchesInputReceipt(receipt, "background-coordinate", { x: 12, y: 15 }),
  ).toBe(true);
  expect(
    matchesInputReceipt(
      { ...receipt, outcome: "dispatched" },
      "background-coordinate",
    ),
  ).toBe(true);
  expect(matchesInputReceipt(receipt, "process-coordinate")).toBe(false);
});

it("checks preparation receipts against mouse actions while leaving keyboard timelines alone", () => {
  for (const [command, expected] of [
    [{ kind: "drag", start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }, true],
    [
      {
        kind: "timeline",
        frames: [
          { atMs: 0, keyDown: ["C"] },
          { atMs: 50, keyUp: ["C"] },
        ],
      },
      false,
    ],
    [
      {
        kind: "timeline",
        frames: [
          { atMs: 0, pointerDown: point },
          { atMs: 50, pointerUp: true },
        ],
      },
      true,
    ],
    [
      {
        kind: "timeline",
        frames: [
          { atMs: 0, pointerDown: point, pointerModifiers: ["Meta"] },
          { atMs: 50, pointerUp: true },
        ],
      },
      false,
    ],
  ] as const) {
    expect(inputRequestsPreparation(cuaInputCommandSchema.parse(command))).toBe(
      expected,
    );
    const receipt: CuaInputReceipt = {
      method: "background-timeline",
      activation: expected,
      outcome: "unknown",
      windowDelivery: "unverified",
    };
    expect(
      matchesInputReceipt(receipt, receipt.method, undefined, expected),
    ).toBe(true);
    expect(
      matchesInputReceipt(
        { ...receipt, activation: !expected },
        receipt.method,
        undefined,
        expected,
      ),
    ).toBe(false);
  }
});

it.each([
  "background-prepared-press",
  "background-timeline",
  "background-key",
  "background-text",
  "background-drag",
  "background-scroll",
  "system-media",
] as const)(
  "accepts current and legacy %s outcomes without interpreting user activity as cancellation",
  (method) => {
    for (const outcome of ["dispatched", "unknown"] as const) {
      const receipt: CuaInputReceipt = {
        method,
        outcome,
        activation: method === "background-prepared-press",
        ...(method === "system-media"
          ? {}
          : { windowDelivery: "unverified" as const }),
        effects: {
          beforeAtMs: 1,
          afterAtMs: 2,
          sampling: "before-after-dispatch",
          foregroundApplication: "changed",
          foregroundWindow: "changed",
          pointer: "changed",
          windowOrder: "changed",
        },
      };
      expect(matchesInputReceipt(receipt, method)).toBe(true);
      if (method !== "system-media")
        expect(
          matchesInputReceipt(
            { ...receipt, windowDelivery: undefined },
            method,
          ),
        ).toBe(false);
    }
  },
);
