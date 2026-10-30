import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
    activeSurface: kind ? { kind, entity: { kind: "terminal" } } : undefined,
    surfaces: [],
    gridArea: "center-body",
  } as unknown as VisibleProjectPane;
}

describe("generic pane body alongside persistent surfaces", () => {
  it.each(
    [
      "chat",
      "browser",
      "code",
      "explorer",
      "file",
      "remote-desktop",
      "terminal",
    ].flatMap((kind) => [false, true].map((nested) => ({ kind, nested }))),
  )(
    "does not consume layout space beside persistent $kind (nested=$nested)",
    ({ kind, nested }) => {
      expect(genericPaneBody({}, presentation(kind), nested)).toBeNull();
    },
  );

  it("retains the ordinary body for a non-persistent surface", () => {
    expect(genericPaneBody({}, presentation("history"), true)).not.toBeNull();
  });

  it("identifies the project in the empty-pane state", () => {
    const markup = renderToStaticMarkup(
      genericPaneBody(
        { selectedProject: { name: "Obelisk" } },
        presentation(),
        true,
      ),
    );
    expect(markup).toContain('aria-label="Empty workspace"');
    expect(markup).toContain("Obelisk");
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
