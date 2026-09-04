import { describe, expect, it } from "vitest";

import {
  centerLayoutPaneIds,
  centerSplitDirectionForEdge,
  centerSplitFractionForKey,
  centerSplitPlacesNewPaneFirst,
  replaceCenterSplitFraction,
  removeCenterPaneFromRoot,
  resolvedCenterLayoutRoot,
  splitCenterPaneRoot,
  type CenterLayoutNode,
} from "./center-split-layout";

const root: CenterLayoutNode = {
  kind: "split",
  id: "root",
  direction: "horizontal",
  fraction: 0.6,
  first: { kind: "pane", paneId: "left" },
  second: {
    kind: "split",
    id: "right",
    direction: "vertical",
    fraction: 0.4,
    first: { kind: "pane", paneId: "top-right" },
    second: { kind: "pane", paneId: "bottom-right" },
  },
};

describe("center split layout", () => {
  it("walks recursive leaves in visual order", () => {
    expect(centerLayoutPaneIds(root)).toEqual([
      "left",
      "top-right",
      "bottom-right",
    ]);
  });

  it("removes stale leaves and promotes their sibling", () => {
    expect(
      resolvedCenterLayoutRoot({
        centerPaneIds: ["left", "bottom-right"],
        root,
      }),
    ).toEqual({
      kind: "split",
      id: "root",
      direction: "horizontal",
      fraction: 0.6,
      first: { kind: "pane", paneId: "left" },
      second: { kind: "pane", paneId: "bottom-right" },
    });
  });

  it("derives a deterministic local tree for a mixed-version layout", () => {
    expect(
      resolvedCenterLayoutRoot({
        centerPaneIds: ["one", "two"],
        preferredPaneId: "two",
        root: undefined,
      }),
    ).toEqual({
      kind: "split",
      id: "legacy-center-split:0:one",
      direction: "horizontal",
      fraction: 0.5,
      first: { kind: "pane", paneId: "one" },
      second: { kind: "pane", paneId: "two" },
    });
  });

  it("treats null as a supported empty center tree", () => {
    expect(
      resolvedCenterLayoutRoot({ centerPaneIds: ["one"], root: null }),
    ).toBeNull();
  });

  it("updates one nested split without disturbing siblings", () => {
    const updated = replaceCenterSplitFraction(root, "right", 0.7);
    expect(updated).not.toBe(root);
    expect(updated.kind === "split" && updated.first).toBe(
      root.kind === "split" && root.first,
    );
    expect(
      updated.kind === "split" &&
        updated.second.kind === "split" &&
        updated.second.fraction,
    ).toBe(0.7);
  });

  it("collapses a removed pane and inserts a pane on the requested edge", () => {
    const withoutTopRight = removeCenterPaneFromRoot(root, "top-right");
    expect(centerLayoutPaneIds(withoutTopRight)).toEqual([
      "left",
      "bottom-right",
    ]);
    expect(
      splitCenterPaneRoot(withoutTopRight!, {
        edge: "top",
        fraction: 0.4,
        newPaneId: "new",
        splitId: "new-split",
        targetPaneId: "bottom-right",
      }),
    ).toMatchObject({
      second: {
        direction: "vertical",
        first: { paneId: "new" },
        second: { paneId: "bottom-right" },
      },
    });
  });

  it("maps edges and keyboard resizing to the documented axes", () => {
    expect(centerSplitDirectionForEdge("left")).toBe("horizontal");
    expect(centerSplitDirectionForEdge("bottom")).toBe("vertical");
    expect(centerSplitPlacesNewPaneFirst("top")).toBe(true);
    expect(centerSplitPlacesNewPaneFirst("right")).toBe(false);
    expect(centerSplitFractionForKey("horizontal", 0.5, "ArrowRight")).toBe(
      0.55,
    );
    expect(centerSplitFractionForKey("vertical", 0.5, "ArrowUp")).toBe(0.45);
    expect(centerSplitFractionForKey("vertical", 0.7, "Enter")).toBe(0.5);
    expect(centerSplitFractionForKey("vertical", 0.5, "ArrowLeft")).toBeNull();
  });
});
