import { DndContext } from "@dnd-kit/core";
import type { ProjectSurfaceLauncher } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProjectSurface } from "@/lib/project-surface";

import { DockRail } from "./project-workspace-frame";

vi.mock("@/components/app/global-content-host", () => ({
  DetachedPanePlaceholder: () => null,
  GlobalContentHost: () => null,
}));
vi.mock("@/components/app/persistent-surface-layer", () => ({
  PersistentSurfaceLayer: () => null,
}));
vi.mock("@/components/app/project-pane-render-bindings", () => ({
  projectPaneRenderBindings: () => ({}),
}));

const surface = {
  definition: { id: "project.chat" },
  entity: {},
  kind: "chat",
  paneId: "pane-1",
  projectId: "project-1",
  tabKey: "chat:chat-1",
  title: "Agent chat",
} as unknown as ProjectSurface;

function renderRail(region: "right" | "bottom") {
  const launcher = {
    id: `launcher-${region}`,
    location: `${region}-rail`,
    pinned: true,
    projectId: "project-1",
    target: { definitionId: "git.history", kind: "definition" },
  } as ProjectSurfaceLauncher;

  return renderToStaticMarkup(
    <DndContext>
      <TooltipProvider delayDuration={0}>
        <DockRail
          activeTabKey={null}
          allSurfaces={[surface]}
          launchers={[launcher]}
          onCreate={vi.fn()}
          pending={false}
          pane={undefined}
          projectId="project-1"
          region={region}
          surfaces={[surface]}
          onOpenLauncher={vi.fn()}
          onSelect={vi.fn()}
        />
      </TooltipProvider>
    </DndContext>,
  );
}

describe("dock rail tooltips", () => {
  it.each(["right", "bottom"] as const)(
    "uses shadcn tooltip triggers without native titles on the %s rail",
    (region) => {
      const markup = renderRail(region);

      expect(markup.match(/data-state="closed"/gu)).toHaveLength(4);
      expect(markup).toContain(
        `aria-label="Focus Agent chat in ${region} dock"`,
      );
      expect(markup).toContain(`aria-label="Add surface to ${region} dock"`);
      expect(markup).toContain(`aria-label="Open History in ${region} dock"`);
      expect(markup).toContain('aria-haspopup="menu"');
      expect(markup).not.toContain('role="tablist"');
      expect(markup).not.toContain(" title=");
    },
  );
});
