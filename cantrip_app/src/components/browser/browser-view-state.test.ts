import { describe, expect, it } from "vitest";
import { parseBrowserViewState } from "./browser-view-state";

const owner = {
  browserId: "browser",
  projectId: "project",
  workerId: "worker",
};
const state = {
  ...owner,
  version: 1,
  address: "unfinished address",
  addressDirty: true,
  currentUrl: "https://example.com/",
  invalidAddress: true,
  serviceSearch: "local service",
  viewport: { width: 640, height: 480, devicePixelRatio: 2 },
};

describe("browser transfer state", () => {
  it("preserves an unsubmitted invalid draft separately from the loaded page", () => {
    expect(parseBrowserViewState(state, owner)).toEqual(state);
  });

  it("accepts an empty draft and strips fields outside the private view contract", () => {
    const expected = { ...state, address: "", serviceSearch: "" };
    expect(
      parseBrowserViewState({ ...expected, lifecycle: "not-data" }, owner),
    ).toEqual(expected);
  });

  it.each(["browserId", "projectId", "workerId"] as const)(
    "rejects another %s even when all other view data is valid",
    (key) => {
      expect(() =>
        parseBrowserViewState({ ...state, [key]: "other" }, owner),
      ).toThrow("does not match its reservation");
    },
  );

  it.each([
    null,
    [],
    { ...state, version: 2 },
    { ...state, addressDirty: "true" },
    { ...state, currentWorkerId: 12 },
    { ...state, viewport: { width: 0, height: 480, devicePixelRatio: 2 } },
  ])("rejects malformed state without coercing private fields", (value) => {
    expect(() => parseBrowserViewState(value, owner)).toThrow();
  });

  it("rejects an empty owner even if the payload matches it", () => {
    const emptyOwner = { ...owner, workerId: "" };
    expect(() =>
      parseBrowserViewState({ ...state, ...emptyOwner }, emptyOwner),
    ).toThrow("Invalid browser transfer owner");
  });
});
