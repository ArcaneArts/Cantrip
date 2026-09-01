import { DndContext } from "@dnd-kit/core";
import {
  explorerSummarySchema,
  projectTabMemberSummarySchema,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { ProjectFileSurface } from "@/lib/project-surface";

import { ProjectTabBar } from "./project-tab-bar";

vi.mock("@radix-ui/react-context-menu", async () => {
  const React = await import("react");
  const Container = React.forwardRef<unknown, { children?: React.ReactNode }>(
    ({ children }, _ref) => React.createElement(React.Fragment, null, children),
  );
  const Item = React.forwardRef<
    unknown,
    { children?: React.ReactNode; onSelect?(): void }
  >(({ children, onSelect }, _ref) =>
    React.createElement(
      "button",
      { onClick: onSelect, type: "button" },
      children,
    ),
  );
  return {
    Content: Container,
    Item,
    Portal: Container,
    Root: Container,
    Separator: () => null,
    Trigger: Container,
  };
});
vi.mock("@radix-ui/react-dropdown-menu", async () => {
  const React = await import("react");
  const Container = React.forwardRef<unknown, { children?: React.ReactNode }>(
    ({ children }, _ref) => React.createElement(React.Fragment, null, children),
  );
  const Item = React.forwardRef<
    unknown,
    { children?: React.ReactNode; onSelect?(): void }
  >(({ children, onSelect }, _ref) =>
    React.createElement(
      "button",
      { onClick: onSelect, type: "button" },
      children,
    ),
  );
  return {
    Content: Container,
    Item,
    Portal: Container,
    Root: Container,
    Separator: () => null,
    Trigger: Container,
  };
});
vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    confirmLabel,
    confirmVariant,
    title,
  }: {
    confirmLabel: string;
    confirmVariant?: string;
    title: string;
  }) => (
    <div
      data-confirm-label={confirmLabel}
      data-confirm-variant={confirmVariant}
    >
      {title}
    </div>
  ),
}));
vi.mock("./project-surface-create-menu", () => ({
  ProjectSurfaceCreateMenu: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const now = "2026-08-23T12:00:00.000Z";

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value && typeof value === "object" && "props" in value) {
    return textContent(
      (value as { props: { children?: unknown } }).props.children,
    );
  }
  return "";
}

function fileSurface(): ProjectFileSurface {
  const explorer = explorerSummarySchema.parse({
    id: "explorer-1",
    projectId: "project-1",
    title: "index.ts",
    position: 0,
    activeWorkerId: "worker-1",
    worktreeId: "worktree-1",
    selectedPath: "src/index.ts",
    fileMode: "edit",
    createdAt: now,
    updatedAt: now,
  });
  const member = projectTabMemberSummarySchema.parse({
    tabKey: `explorer:${explorer.id}`,
    groupId: "group-1",
    projectId: explorer.projectId,
    tabKind: "explorer",
    tabId: explorer.id,
    title: explorer.title,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });
  return {
    entity: explorer,
    groupId: member.groupId,
    kind: "explorer",
    member,
    projectId: explorer.projectId,
    tabId: explorer.id,
    tabKey: member.tabKey,
    title: explorer.title,
  };
}

function renderTabs(surface: ProjectFileSurface) {
  return renderToStaticMarkup(
    <DndContext>
      <ProjectTabBar
        activeTabKey=""
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onSelect={vi.fn()}
        surfaces={[surface]}
      />
    </DndContext>,
  );
}

describe("project tab bar", () => {
  it("selects the full tab title and disables dragging while renaming", async () => {
    const select = vi.fn();
    const surface = fileSurface();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <ProjectTabBar
            activeTabKey={surface.tabKey}
            onClose={vi.fn()}
            onCreate={vi.fn()}
            onDelete={vi.fn()}
            onRename={vi.fn()}
            onSelect={vi.fn()}
            surfaces={[surface]}
          />
        </DndContext>,
        {
          createNodeMock: (element) =>
            element.type === "input" ? { select } : null,
        },
      );
    });

    let frame = renderer.root.findByProps({
      "data-project-tab-frame": surface.tabKey,
    });
    expect(frame.props.onPointerDown).toEqual(expect.any(Function));
    const tab = renderer.root.findByProps({ role: "tab" });
    const event = { preventDefault: vi.fn() };

    await act(async () => tab.props.onDoubleClick(event));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(
      renderer.root.findByProps({ "aria-label": "Rename index.ts" }).props
        .value,
    ).toBe("index.ts");
    expect(select).toHaveBeenCalledOnce();
    frame = renderer.root.findByProps({
      "data-project-tab-frame": surface.tabKey,
    });
    expect(frame.props.onPointerDown).toBeUndefined();
    expect(frame.props.onKeyDown).toBeUndefined();

    await act(async () => renderer.unmount());
  });

  it("renders a left-clicked file as an italic filename preview in its target group", async () => {
    const onPin = vi.fn();
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <ProjectTabBar
            activeTabKey=""
            onClose={vi.fn()}
            onCreate={vi.fn()}
            onDelete={vi.fn()}
            onRename={vi.fn()}
            onSelect={vi.fn()}
            previewFile={{
              active: true,
              path: "src/preview-file.ts",
              projectId: "project-1",
              title: "preview-file.ts",
              onClose: vi.fn(),
              onPin,
              onSelect,
            }}
            surfaces={[]}
          />
        </DndContext>,
      );
    });

    const preview = renderer.root.findByProps({
      "data-preview-file-path": "src/preview-file.ts",
    });
    const previewButton = preview.findByProps({ role: "tab" });
    expect(textContent(previewButton.props.children)).toContain(
      "preview-file.ts",
    );
    expect(previewButton.props.className).toContain("italic");

    await act(async () => previewButton.props.onClick());
    expect(onSelect).toHaveBeenCalledOnce();
    const event = { preventDefault: vi.fn() };
    await act(async () => previewButton.props.onDoubleClick(event));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onPin).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("closes a File preview tab on middle click", async () => {
    const onClose = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <ProjectTabBar
            activeTabKey=""
            onClose={vi.fn()}
            onCreate={vi.fn()}
            onDelete={vi.fn()}
            onRename={vi.fn()}
            onSelect={vi.fn()}
            previewFile={{
              active: true,
              path: "src/file.ts",
              projectId: "project-1",
              title: "file.ts",
              onClose,
              onPin: vi.fn(),
              onSelect: vi.fn(),
            }}
            surfaces={[]}
          />
        </DndContext>,
      );
    });
    const preview = renderer.root.findByProps({
      "data-preview-file-path": "src/file.ts",
    });
    const mouseDown = { button: 1, preventDefault: vi.fn() };
    const auxiliaryClick = {
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    preview.props.onMouseDown(mouseDown);
    preview.props.onAuxClick(auxiliaryClick);

    expect(mouseDown.preventDefault).toHaveBeenCalledOnce();
    expect(auxiliaryClick.preventDefault).toHaveBeenCalledOnce();
    expect(auxiliaryClick.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("renders only the pinned file presentation", () => {
    const markup = renderTabs(fileSurface());

    expect(markup).toContain("lucide-file-code-corner");
    expect(markup).toContain("index.ts");
    expect(markup).toContain('aria-label="Project file tabs"');
  });

  it("presents pinned file removal as a neutral Close action", () => {
    const markup = renderTabs(fileSurface());

    expect(markup.match(/Close/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(markup.match(/lucide-x/gu)).toHaveLength(2);
    expect(markup).not.toContain("lucide-trash-2");
    expect(markup).not.toContain("text-destructive");
    expect(markup).toContain('data-confirm-label="Close"');
    expect(markup).toContain('data-confirm-variant="default"');
    expect(markup).toContain("Close file tab?");
  });
});
