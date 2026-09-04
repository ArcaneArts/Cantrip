import { DndContext } from "@dnd-kit/core";
import {
  chatSummarySchema,
  explorerSummarySchema,
  projectTabMemberSummarySchema,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { ProjectFileSurface, ProjectSurface } from "@/lib/project-surface";
import { projectSurfaceIdentityForTab } from "@/lib/project-surface-registry";
import { WorkspaceDndStateProvider } from "./workspace-dnd-state";

import { ProjectPaneTabStrip } from "./project-tab-bar";

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
    onConfirm,
    open,
    title,
  }: {
    confirmLabel: string;
    confirmVariant?: string;
    onConfirm(): void;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <button
        data-confirm-label={confirmLabel}
        data-confirm-variant={confirmVariant}
        onClick={onConfirm}
        type="button"
      >
        {title}
      </button>
    ) : null,
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
    paneId: "pane-1",
    projectId: explorer.projectId,
    tabKind: "explorer",
    tabId: explorer.id,
    title: explorer.title,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });
  const identity = projectSurfaceIdentityForTab({
    kind: "explorer",
    projectId: explorer.projectId,
    resourceId: explorer.id,
    file: true,
  });
  return {
    definition: identity.definition,
    entity: explorer,
    paneId: member.paneId,
    kind: "explorer",
    member,
    placement: {
      paneId: member.paneId,
      position: member.position,
      viewId: identity.viewId,
    },
    projectId: explorer.projectId,
    resource: { entity: explorer, ref: identity.resource },
    tabId: explorer.id,
    tabKey: member.tabKey,
    title: explorer.title,
    view: {
      id: identity.viewId,
      projectId: explorer.projectId,
      resource: identity.resource,
    },
  };
}

function chatSurface(): Extract<ProjectSurface, { kind: "chat" }> {
  const chat = chatSummarySchema.parse({
    activeWorkerId: "worker-1",
    activeWorktreeId: "worktree-1",
    automationPaused: false,
    createdAt: now,
    experience: "agent",
    hasPendingPlanQuestion: false,
    hasUnreadCompletion: false,
    id: "agent-1",
    modelId: null,
    permissionProfileId: null,
    placementRevision: 1,
    planMode: "default",
    position: 1,
    projectId: "project-1",
    reasoningEffort: null,
    status: "idle",
    title: "Agent chat",
    updatedAt: now,
    worktreeMode: "agent-managed",
  });
  const member = projectTabMemberSummarySchema.parse({
    createdAt: now,
    paneId: "pane-1",
    position: 1,
    projectId: chat.projectId,
    tabId: chat.id,
    tabKey: `chat:${chat.id}`,
    tabKind: "chat",
    title: chat.title,
    updatedAt: now,
  });
  const identity = projectSurfaceIdentityForTab({
    kind: "chat",
    projectId: chat.projectId,
    resourceId: chat.id,
  });
  return {
    definition: identity.definition,
    entity: chat,
    kind: "chat",
    member,
    paneId: member.paneId,
    placement: {
      paneId: member.paneId,
      position: member.position,
      viewId: identity.viewId,
    },
    projectId: chat.projectId,
    resource: { entity: chat, ref: identity.resource },
    tabId: chat.id,
    tabKey: member.tabKey,
    title: chat.title,
    view: {
      id: identity.viewId,
      projectId: chat.projectId,
      resource: identity.resource,
    },
  };
}

function renderTabs(surface: ProjectFileSurface) {
  return renderToStaticMarkup(
    <DndContext>
      <ProjectPaneTabStrip
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

describe("project pane tab strip", () => {
  it("leaves the strip background transparent for the app shell", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <ProjectPaneTabStrip
            activeTabKey=""
            onClose={vi.fn()}
            onCreate={vi.fn()}
            onDelete={vi.fn()}
            onRename={vi.fn()}
            onSelect={vi.fn()}
            surfaces={[fileSurface()]}
          />
        </DndContext>,
      );
    });

    const tablist = renderer.root.findByProps({ role: "tablist" });
    expect(tablist.parent?.props.className.split(/\s+/u)).not.toContain(
      "bg-background",
    );
    await act(async () => renderer.unmount());
  });

  it("selects the full tab title and disables dragging while renaming", async () => {
    const select = vi.fn();
    const surface = fileSurface();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <ProjectPaneTabStrip
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
          <ProjectPaneTabStrip
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
          <ProjectPaneTabStrip
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
    expect(markup).toContain('aria-label="Project pane tabs"');
  });

  it("renders file and agent surfaces together in one pane strip", () => {
    const markup = renderToStaticMarkup(
      <DndContext>
        <ProjectPaneTabStrip
          activeTabKey="chat:agent-1"
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onDelete={vi.fn()}
          onRename={vi.fn()}
          onSelect={vi.fn()}
          surfaces={[fileSurface(), chatSurface()]}
        />
      </DndContext>,
    );

    expect(markup).toContain("index.ts");
    expect(markup).toContain("Agent chat");
    expect(markup.match(/role="tab"/gu)).toHaveLength(2);
  });

  it("uses visual indexes for drag targets when persisted positions are sparse", async () => {
    const first = fileSurface();
    const second = chatSurface();
    second.member.position = 7;
    second.placement.position = 7;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <ProjectPaneTabStrip
            activeTabKey={first.tabKey}
            onClose={vi.fn()}
            onCreate={vi.fn()}
            onDelete={vi.fn()}
            onRename={vi.fn()}
            onSelect={vi.fn()}
            surfaces={[first, second]}
          />
        </DndContext>,
      );
    });

    expect(
      renderer.root.findByProps({
        "data-project-tab-frame": second.tabKey,
      }).props["data-project-tab-position"],
    ).toBe(1);
    await act(async () => renderer.unmount());
  });

  it("shows a live center insertion placeholder for a dock tab", async () => {
    const first = fileSurface();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <WorkspaceDndStateProvider
            value={{
              activeDrag: {
                type: "surface",
                projectId: "project-1",
                paneId: "pane-bottom",
                tabKey: "terminal:shell",
                label: "Terminal",
                position: 0,
                supportedRegions: ["center", "right", "bottom"],
                visualKind: "terminal",
              },
              decision: {
                status: "valid",
                operation: {
                  type: "tab-layout",
                  projectId: "project-1",
                  command: {
                    type: "move-member",
                    tabKey: "terminal:shell",
                    targetPaneId: "pane-1",
                    targetMemberPosition: 0,
                  },
                },
              },
              dropTarget: {
                type: "pane-tab",
                projectId: "project-1",
                paneId: "pane-1",
                tabKey: first.tabKey,
                memberPosition: 0,
              },
            }}
          >
            <ProjectPaneTabStrip
              activeTabKey={first.tabKey}
              onClose={vi.fn()}
              onCreate={vi.fn()}
              onDelete={vi.fn()}
              onRename={vi.fn()}
              onSelect={vi.fn()}
              paneId="pane-1"
              projectId="project-1"
              surfaces={[first]}
            />
          </WorkspaceDndStateProvider>
        </DndContext>,
      );
    });

    const placeholder = renderer.root.findByProps({
      "data-workspace-drop-placeholder": "terminal:shell",
    });
    expect(placeholder.props.style).toMatchObject({ height: 40, width: 160 });

    await act(async () => renderer.unmount());
  });

  it("presents Close View separately from destructive resource deletion", () => {
    const markup = renderTabs(fileSurface());

    expect(markup.match(/Close View/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(markup.match(/Delete Resource/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(markup.match(/lucide-x/gu)).toHaveLength(2);
    expect(markup.match(/lucide-trash-2/gu)).toHaveLength(2);
    expect(markup).not.toContain("Close file tab?");
  });

  it("routes middle-click and menu close through view lifecycle only", async () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const surface = fileSurface();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DndContext>
          <ProjectPaneTabStrip
            activeTabKey={surface.tabKey}
            onClose={onClose}
            onCreate={vi.fn()}
            onDelete={onDelete}
            onRename={vi.fn()}
            onSelect={vi.fn()}
            surfaces={[surface]}
          />
        </DndContext>,
      );
    });

    const frame = renderer.root.findByProps({
      "data-project-tab-key": surface.tabKey,
    });
    frame.props.onAuxClick({
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(onClose).toHaveBeenCalledWith(surface);
    expect(onDelete).not.toHaveBeenCalled();

    onClose.mockClear();
    const menuButtons = renderer.root.findAllByType("button");
    menuButtons
      .find((button) => textContent(button).trim() === "Close View")!
      .props.onClick();
    expect(onClose).toHaveBeenCalledWith(surface);
    expect(onDelete).not.toHaveBeenCalled();

    await act(async () =>
      menuButtons
        .find((button) => textContent(button).trim() === "Delete Resource")!
        .props.onClick(),
    );
    expect(onDelete).not.toHaveBeenCalled();
    const confirm = renderer.root.findByProps({
      "data-confirm-label": "Delete Resource",
    });
    expect(confirm.props["data-confirm-variant"]).toBe("destructive");
    await act(async () => confirm.props.onClick());
    expect(onDelete).toHaveBeenCalledWith(surface);

    await act(async () => renderer.unmount());
  });
});
