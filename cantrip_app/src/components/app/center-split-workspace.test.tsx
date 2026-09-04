import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CenterSplitWorkspace } from "./center-split-workspace";
import type { VisibleProjectPane } from "./project-workspace-frame-model";

const timestamp = "2026-09-04T12:00:00.000Z";

describe("center split workspace", () => {
  it("renders center content without drag-to-split edge targets", () => {
    const presentation: VisibleProjectPane = {
      activeSurface: undefined,
      activeTabKey: "view:overview",
      focused: true,
      gridArea: "center-body",
      pane: {
        id: "center-pane",
        projectId: "project-1",
        region: "center",
        title: "Center",
        position: 0,
        anchorTabKey: "view:overview",
        createdAt: timestamp,
        updatedAt: timestamp,
        members: [],
      },
      surfaces: [],
    };

    const markup = renderToStaticMarkup(
      <CenterSplitWorkspace
        controlsEnabled
        node={{ kind: "pane", paneId: presentation.pane.id }}
        onResize={vi.fn()}
        presentationByPaneId={new Map([[presentation.pane.id, presentation]])}
        renderPaneBody={() => <div>Overview</div>}
        renderTabStrip={() => <div>Tabs</div>}
      />,
    );

    expect(markup).toContain('data-center-pane="center-pane"');
    expect(markup).toContain("Overview");
    expect(markup).not.toContain("data-center-pane-edge");
  });
});
