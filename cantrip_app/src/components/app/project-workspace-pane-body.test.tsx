import { describe, expect, it, vi } from "vitest";
import type { VisibleProjectPane } from "./project-workspace-frame-model";
import { genericPaneBody } from "./project-workspace-frame";

vi.mock("./global-content-host", () => ({
  DetachedPanePlaceholder: () => null,
  GlobalContentHost: () => null,
}));
vi.mock("./persistent-surface-layer", () => ({
  PersistentSurfaceLayer: () => null,
}));
vi.mock("./project-pane-render-bindings", () => ({
  projectPaneRenderBindings: (bindings: unknown) => bindings,
}));

function presentation(kind?: string): VisibleProjectPane {
  return {
    pane: { id: "pane", region: "center" },
    activeSurface: kind ? { kind } : undefined,
    surfaces: [],
    gridArea: "center-body",
  } as unknown as VisibleProjectPane;
}

describe("generic pane body alongside persistent surfaces", () => {
  it.each([false, true])(
    "does not consume layout space beside a persistent remote desktop (nested=%s)",
    (nested) => {
      expect(
        genericPaneBody({}, presentation("remote-desktop"), nested),
      ).toBeNull();
    },
  );

  it("retains the ordinary body for a non-persistent surface", () => {
    expect(genericPaneBody({}, presentation("history"), true)).not.toBeNull();
  });

  it("retains the empty-pane state", () => {
    expect(genericPaneBody({}, presentation(), true)).not.toBeNull();
  });

  it("retains legacy detached ownership handling", () => {
    expect(
      genericPaneBody(
        { paneOwnedElsewhere: () => true },
        presentation("remote-desktop"),
        true,
      ),
    ).not.toBeNull();
  });
});
