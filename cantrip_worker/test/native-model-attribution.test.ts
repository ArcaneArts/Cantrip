import { describe, expect, it } from "vitest";
import type { NativeModelInventory } from "@cantrip/protocol";
import { nativeModelAttribution } from "../src/native-model-attribution.js";
const scope = {
  workerId: "worker",
  providerAccountId: "account",
  modelRouteId: "anchor",
};
const inventory: NativeModelInventory = {
  workerId: "worker",
  providerId: "provider",
  providerAccountId: "account",
  providerKind: "chatgpt",
  models: [
    { id: "a", routeId: "anchor", name: "one", reasoningEffort: null },
    { id: "b", routeId: "next", name: "two", reasoningEffort: null },
    { id: "a-alias", routeId: "alias", name: "one", reasoningEffort: null },
  ],
};
describe("native model attribution", () => {
  it("retains the exact current alias and maps a unique new selection within the same account", () => {
    expect(nativeModelAttribution(scope, "one", inventory)).toMatchObject({
      status: "resolved",
      routeId: "anchor",
      modelId: "a",
    });
    expect(nativeModelAttribution(scope, "two", inventory)).toEqual({
      status: "resolved",
      workerId: "worker",
      providerId: "provider",
      providerAccountId: "account",
      modelId: "b",
      routeId: "next",
    });
    expect(scope.modelRouteId).toBe("anchor");
  });
  it("does not guess ambiguous, absent or other-account/worker routes", () => {
    expect(
      nativeModelAttribution(
        { ...scope, modelRouteId: null },
        "one",
        inventory,
      ),
    ).toEqual({ status: "ambiguous" });
    expect(nativeModelAttribution(scope, "missing", inventory)).toEqual({
      status: "unmapped",
    });
    expect(nativeModelAttribution(scope, "two", null)).toEqual({
      status: "unavailable",
    });
    expect(
      nativeModelAttribution(
        { ...scope, providerAccountId: "other" },
        "two",
        inventory,
      ),
    ).toEqual({ status: "unavailable" });
    expect(
      nativeModelAttribution({ ...scope, workerId: "other" }, "two", inventory),
    ).toEqual({ status: "unavailable" });
  });
});
