import { describe, expect, it } from "vitest";
import { parseRemoteDesktopViewState } from "./remote-desktop-view-state";

const owner = {
  desktopId: "desktop",
  projectId: "project",
  workerId: "worker",
};
const state = {
  version: 1,
  ...owner,
  viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
  fleetOpen: true,
  targetSearch: "Editor",
};

describe("remote desktop transfer state", () => {
  it("preserves private view state for the reserved resource", () => {
    expect(parseRemoteDesktopViewState(state, owner)).toEqual(state);
    expect(
      parseRemoteDesktopViewState(
        { ...state, targetSearch: "", fleetOpen: false },
        owner,
      ),
    ).toMatchObject({ targetSearch: "", fleetOpen: false });
  });

  it.each(["desktopId", "projectId", "workerId"] as const)(
    "rejects a different %s",
    (key) => {
      expect(() =>
        parseRemoteDesktopViewState({ ...state, [key]: "other" }, owner),
      ).toThrow("does not match its reservation");
    },
  );

  it.each([
    { version: 2 },
    { viewport: { ...state.viewport, width: -1 } },
    { viewport: { ...state.viewport, height: Infinity } },
    { fleetOpen: "true" },
    { inputEpoch: "source-attachment" },
    { targetSearch: null },
  ])("rejects invalid or attachment-owned state: %j", (invalid) => {
    expect(() =>
      parseRemoteDesktopViewState({ ...state, ...invalid }, owner),
    ).toThrow();
  });
});
