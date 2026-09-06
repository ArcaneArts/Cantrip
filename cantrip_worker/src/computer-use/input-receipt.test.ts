import { describe, expect, it } from "vitest";
import { matchesInputReceipt } from "./input-receipt.js";
import type { CuaInputReceipt } from "./types.js";

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

it("requires unverified unknown receipts for experimental background delivery", () => {
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
  ).toBe(false);
  expect(matchesInputReceipt(receipt, "process-coordinate")).toBe(false);
});
