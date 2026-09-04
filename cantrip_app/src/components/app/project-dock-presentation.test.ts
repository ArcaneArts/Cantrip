import type { ProjectDockPresentationPreference } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import type { VisibleProjectPane } from "@/components/app/project-workspace-frame-model";

import {
  DEFAULT_DOCK_PRESENTATION,
  dockPresentationForKey,
  dockPresentationForPane,
  dockResizeCandidate,
  effectiveDockFraction,
  focusedFullDockRegion,
  resizeDockPresentation,
  revealDockPresentation,
  restoreDockPresentation,
} from "./project-dock-presentation";

const split = (fraction = 0.32): ProjectDockPresentationPreference => ({
  preferredMode: "split",
  restoreFraction: fraction,
  splitFraction: fraction,
});

function visiblePane(
  region: "center" | "right" | "bottom",
  preference: ProjectDockPresentationPreference | null | undefined,
  focused = false,
): VisibleProjectPane {
  return {
    activeSurface: {
      member: { dockPresentation: preference },
    } as VisibleProjectPane["activeSurface"],
    activeTabKey: `${region}:tab`,
    focused,
    gridArea: `${region}-body`,
    pane: { id: `${region}:pane`, region } as VisibleProjectPane["pane"],
    surfaces: [],
  };
}

describe("dock presentation preferences", () => {
  it("uses the compatibility default for missing or null dock preferences", () => {
    expect(dockPresentationForPane(visiblePane("right", undefined))).toEqual(
      DEFAULT_DOCK_PRESENTATION,
    );
    expect(dockPresentationForPane(visiblePane("bottom", null))).toEqual(
      DEFAULT_DOCK_PRESENTATION,
    );
    expect(dockPresentationForPane(visiblePane("center", split()))).toBeNull();
  });

  it("reads independent preferences when the active tab changes", () => {
    expect(
      dockPresentationForPane(visiblePane("right", split(0.27)))?.splitFraction,
    ).toBe(0.27);
    expect(
      dockPresentationForPane(
        visiblePane("right", {
          preferredMode: "full",
          restoreFraction: 0.41,
          splitFraction: 0.41,
        }),
      ),
    ).toEqual({
      preferredMode: "full",
      restoreFraction: 0.41,
      splitFraction: 0.41,
    });
  });

  it("clamps effective geometry without modifying the saved preference", () => {
    const preference = split(0.1);
    expect(effectiveDockFraction(preference.splitFraction, 800, 240, 240)).toBe(
      0.3,
    );
    expect(preference).toEqual(split(0.1));
    expect(effectiveDockFraction(0.32, 300, 240, 240)).toBe(0.5);
  });

  it("snaps with hysteresis and retains the last useful restore fraction", () => {
    const closed = resizeDockPresentation(split(0.32), 0.055);
    expect(closed).toEqual({
      preferredMode: "closed",
      restoreFraction: 0.32,
      splitFraction: 0.32,
    });
    expect(resizeDockPresentation(closed, 0.08).preferredMode).toBe("closed");

    const reopened = resizeDockPresentation(closed, 0.11);
    expect(reopened).toEqual(split(0.11));
    const full = resizeDockPresentation(reopened, 0.945);
    expect(full).toEqual({ ...reopened, preferredMode: "full" });
    expect(resizeDockPresentation(full, 0.92).preferredMode).toBe("full");
    expect(resizeDockPresentation(full, 0.89)).toEqual(split(0.89));
  });

  it("restores full and closed modes to the remembered useful fraction", () => {
    const full = {
      preferredMode: "full",
      restoreFraction: 0.37,
      splitFraction: 0.52,
    } as const;
    expect(restoreDockPresentation(full)).toEqual(split(0.37));
    expect(
      revealDockPresentation({ ...full, preferredMode: "closed" }),
    ).toEqual(split(0.37));
    expect(revealDockPresentation(full)).toBe(full);
    expect(dockPresentationForKey("vertical", full, "Enter")).toEqual(
      split(0.37),
    );
    expect(
      dockPresentationForKey("vertical", split(), "Home")?.preferredMode,
    ).toBe("closed");
    expect(
      dockPresentationForKey("vertical", split(), "End")?.preferredMode,
    ).toBe("full");
    expect(dockPresentationForKey("vertical", split(), "ArrowLeft")).toEqual(
      split(0.37),
    );
    expect(dockPresentationForKey("horizontal", split(), "ArrowUp")).toEqual(
      split(0.37),
    );
  });

  it.each(["closed", "full"] as const)(
    "starts a pointer restore from the remembered fraction when %s",
    (preferredMode) => {
      const preference = {
        preferredMode,
        restoreFraction: 0.32,
        splitFraction: 0.47,
      };
      expect(
        dockResizeCandidate({
          currentCoordinate: 110,
          leadingEdge: 0,
          preference,
          startCoordinate: 100,
          trailingEdge: 500,
        }),
      ).toBeCloseTo(0.3);
      expect(
        resizeDockPresentation(
          preference,
          dockResizeCandidate({
            currentCoordinate: 110,
            leadingEdge: 0,
            preference,
            startCoordinate: 100,
            trailingEdge: 500,
          }),
        ).preferredMode,
      ).toBe("split");
    },
  );

  it("measures a split bottom dock upward from the frame's trailing edge", () => {
    expect(
      dockResizeCandidate({
        currentCoordinate: 350,
        leadingEdge: 0,
        preference: split(0.32),
        startCoordinate: 350,
        trailingEdge: 500,
      }),
    ).toBe(0.3);
  });

  it("lets only the focused full-preferring dock own the workspace", () => {
    const full = {
      preferredMode: "full",
      restoreFraction: 0.32,
      splitFraction: 0.32,
    } as const;
    const right = visiblePane("right", full, true);
    const bottom = visiblePane("bottom", full, false);
    expect(focusedFullDockRegion([right, bottom])).toBe("right");
    expect(
      focusedFullDockRegion([
        { ...right, focused: false },
        { ...bottom, focused: true },
      ]),
    ).toBe("bottom");
    expect(
      focusedFullDockRegion([
        { ...right, focused: false },
        { ...bottom, focused: false },
        visiblePane("center", null, true),
      ]),
    ).toBeNull();
  });
});
