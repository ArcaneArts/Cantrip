import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SortableSidebarSurfaceRow } from "./sortable-sidebar-surface-row";

function renderRow(editing: boolean) {
  const sortId = "terminal:one";
  return renderToStaticMarkup(
    <DndContext>
      <SortableContext items={[sortId]}>
        <SortableSidebarSurfaceRow
          actions={<span>Surface actions</span>}
          active
          editing={editing}
          icon={<span>Terminal icon</span>}
          sortId={sortId}
          status={<span>Running</span>}
          title="Primary terminal"
          trailing={<span>Primary worktree</span>}
          renameValue="Renamed terminal"
          onCancelRename={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onSelect={vi.fn()}
          onSubmitRename={vi.fn()}
        />
      </SortableContext>
    </DndContext>,
  );
}

describe("sortable sidebar surface row", () => {
  it("renders shared surface slots in the normal state", () => {
    const markup = renderRow(false);

    expect(markup).not.toContain("Drag to reorder");
    expect(markup).toContain('aria-roledescription="sortable"');
    expect(markup).toContain("cursor-grab");
    expect(markup).toContain("Terminal icon");
    expect(markup).toContain("Primary terminal");
    expect(markup).toContain("Running");
    expect(markup).toContain("Primary worktree");
    expect(markup).toContain("Surface actions");
  });

  it("replaces surface content and controls with the shared rename field", () => {
    const markup = renderRow(true);

    expect(markup).toContain('aria-label="Rename Primary terminal"');
    expect(markup).toContain('data-elite-ignore=""');
    expect(markup).toContain('value="Renamed terminal"');
    expect(markup).not.toContain("Running");
    expect(markup).not.toContain("Primary worktree");
    expect(markup).not.toContain("Surface actions");
    expect(markup).not.toContain('aria-roledescription="sortable"');
  });
});
