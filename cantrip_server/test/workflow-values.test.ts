import { describe, expect, it } from "vitest";

import {
  evaluateWorkflowPredicate,
  workflowValueAtPointer,
} from "../src/workflows/values.js";

const value = {
  approved: true,
  nested: { "slash/key": { "tilde~key": 4 } },
  items: [{ score: 0.5 }, { score: 0.9 }],
  labels: ["safe", "reviewed"],
};

describe("workflow structured values", () => {
  it("selects RFC 6901 object and array values without coercion", () => {
    expect(workflowValueAtPointer(value, "")).toEqual({
      found: true,
      value,
    });
    expect(workflowValueAtPointer(value, "/items/1/score")).toEqual({
      found: true,
      value: 0.9,
    });
    expect(
      workflowValueAtPointer(value, "/nested/slash~1key/tilde~0key"),
    ).toEqual({ found: true, value: 4 });
    expect(workflowValueAtPointer(value, "/items/01").found).toBe(false);
    expect(workflowValueAtPointer(value, "/missing").found).toBe(false);
  });

  it("evaluates deterministic predicates and fails closed on bad types", () => {
    expect(
      evaluateWorkflowPredicate(value, {
        path: "/approved",
        operator: "equals",
        value: true,
      }),
    ).toBe(true);
    expect(
      evaluateWorkflowPredicate(value, {
        path: "/items/1/score",
        operator: "greater-than-or-equals",
        value: 0.9,
      }),
    ).toBe(true);
    expect(
      evaluateWorkflowPredicate(value, {
        path: "/labels",
        operator: "contains",
        value: "reviewed",
      }),
    ).toBe(true);
    expect(
      evaluateWorkflowPredicate(value, {
        path: "/missing",
        operator: "not-exists",
      }),
    ).toBe(true);
    expect(
      evaluateWorkflowPredicate(value, {
        path: "/approved",
        operator: "greater-than",
        value: 0,
      }),
    ).toBe(false);
    expect(
      evaluateWorkflowPredicate(
        { label: "z" },
        {
          path: "/label",
          operator: "greater-than",
          value: "a",
        },
      ),
    ).toBe(true);
  });
});
