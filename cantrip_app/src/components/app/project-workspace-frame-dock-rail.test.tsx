import type { ProjectPaneSummary } from "@cantrip/protocol";
import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";
import {
  WorkspaceDndStateProvider,
  type WorkspaceDndState,
} from "@/components/workspace/workspace-dnd-state";

import { DockRail } from "./project-workspace-frame";

const sortableState = vi.hoisted(() => ({
  contexts: [] as Array<{ items: string[]; strategy: string }>,
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }),
}));
vi.mock("@dnd-kit/sortable", () => ({
  horizontalListSortingStrategy: "horizontal",
  SortableContext: ({
    children,
    items,
    strategy,
  }: {
    children: ReactNode;
    items: string[];
    strategy: string;
  }) => {
    sortableState.contexts.push({ items, strategy });
    return <>{children}</>;
  },
  useSortable: (options: Record<string, unknown>) => {
    sortableState.options.push(options);
    return {
      attributes: { "data-sortable": true },
      isDragging: false,
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: "transform 180ms cubic-bezier(0.2, 0, 0, 1)",
    };
  },
  verticalListSortingStrategy: "vertical",
}));
vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));
vi.mock("@radix-ui/react-context-menu", () => ({
  Portal: ({ children }: { children: ReactNode }) => children,
  Root: ({ children }: { children: ReactNode }) => children,
  Separator: () => <hr />,
  Trigger: ({ children }: { children: ReactNode }) => children,
}));
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
vi.mock("@/components/workspace/project-surface-create-menu", () => ({
  ProjectSurfaceCreateMenu: ({ trigger }: { trigger: ReactNode }) => trigger,
}));
vi.mock("@/components/workspace/project-surface-icon", () => ({
  ProjectSurfaceIcon: ({ kind }: { kind: string }) => <span>{kind}</span>,
}));
vi.mock("@/components/sidebar/project-tool-launchers", () => ({
  ProjectBuiltInSurfaceIcon: () => <span>builtin</span>,
}));
vi.mock("@/components/ui/styled-menu", () => ({
  StyledContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-context-menu>{children}</div>
  ),
  StyledContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect(): void;
  }) => (
    <button data-menu-item onClick={onSelect}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipButton: ({
    children,
    size: _size,
    tooltip,
    tooltipSide: _tooltipSide,
    variant: _variant,
    ...props
  }: {
    children: ReactNode;
    size?: string;
    tooltip: ReactNode;
    tooltipSide?: string;
    variant?: string;
  }) => (
    <button data-tooltip={tooltip} {...props}>
      {children}
    </button>
  ),
  TooltipContent: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));

function surface(
  kind: "browser" | "terminal" | "history",
  id: string,
  title: string,
  position: number,
  definitionId = `project.${kind}`,
): ProjectSurface {
  return {
    definition: {
      deletable: true,
      id: definitionId,
      supportedPlacements: ["center", "right", "bottom"],
    },
    entity: { id },
    kind,
    member: { position },
    paneId: "pane-right",
    placement: { paneId: "pane-right", position },
    projectId: "project-1",
    resource: { entity: { id }, ref: { id } },
    tabId: id,
    tabKey: `${kind}:${id}`,
    title,
    view: { id: `view-${id}` },
  } as unknown as ProjectSurface;
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

function renderRail({
  activeTabKey,
  onClose = vi.fn(),
  onDelete = vi.fn(),
  onSelect = vi.fn(),
  pane,
  region = "right",
  surfaces,
  workspaceDndState,
}: {
  activeTabKey: string | null;
  onClose?(surface: ProjectSurface): void;
  onDelete?(surface: ProjectSurface): void;
  onSelect?(surface: ProjectSurface, active: boolean): void;
  pane?: ProjectPaneSummary;
  region?: "right" | "bottom";
  surfaces: readonly ProjectSurface[];
  workspaceDndState?: WorkspaceDndState;
}) {
  const rail = (
    <DockRail
      activeTabKey={activeTabKey}
      onClose={onClose}
      onCreate={vi.fn()}
      onDelete={onDelete}
      onMoveToRegion={vi.fn()}
      onSelect={onSelect}
      pane={pane}
      pending={false}
      projectId="project-1"
      region={region}
      surfaces={surfaces}
    />
  );
  return TestRenderer.create(
    workspaceDndState ? (
      <WorkspaceDndStateProvider value={workspaceDndState}>
        {rail}
      </WorkspaceDndStateProvider>
    ) : (
      rail
    ),
  );
}

describe("dock rail tabs", () => {
  beforeEach(() => {
    sortableState.contexts.length = 0;
    sortableState.options.length = 0;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it.each([
    ["right", "vertical"],
    ["bottom", "horizontal"],
  ] as const)(
    "registers %s rail members as an animated %s sortable list",
    async (region, strategy) => {
      const browser = surface("browser", "one", "Browser", 0);
      const terminal = surface("terminal", "two", "Terminal", 1);
      let renderer!: TestRenderer.ReactTestRenderer;

      await act(async () => {
        renderer = renderRail({
          activeTabKey: browser.tabKey,
          region,
          surfaces: [browser, terminal],
        });
      });

      const rail = renderer.root.findByProps({ "data-dock-rail": region });
      expect(rail.props.className.split(/\s+/u)).not.toContain("bg-background");
      expect(sortableState.contexts.at(-1)).toEqual({
        items: [
          `workspace:surface:${browser.tabKey}`,
          `workspace:surface:${terminal.tabKey}`,
        ],
        strategy,
      });
      expect(sortableState.options).toHaveLength(2);
      expect(sortableState.options[0]).toMatchObject({
        id: `workspace:surface:${browser.tabKey}`,
        transition: {
          duration: 180,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        },
      });
      expect(sortableState.options[1]).toMatchObject({
        data: {
          drop: { memberPosition: 1, type: "pane-tab" },
        },
      });

      await act(async () => renderer.unmount());
    },
  );

  it("closes rail views and deletes resources without confirmation", async () => {
    const browser = surface("browser", "one", "Browser", 0);
    const terminal = surface("terminal", "two", "Terminal", 1);
    const onClose = vi.fn<(surface: ProjectSurface) => void>();
    const onDelete = vi.fn<(surface: ProjectSurface) => void>();
    const onSelect =
      vi.fn<(surface: ProjectSurface, active: boolean) => void>();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = renderRail({
        activeTabKey: browser.tabKey,
        onClose,
        onDelete,
        onSelect,
        surfaces: [browser, terminal],
      });
    });

    const menuItems = () =>
      renderer.root.findAllByProps({ "data-menu-item": true });
    const closeBrowser = menuItems().find(
      (item) => textContent(item) === " Close View",
    );
    expect(closeBrowser).toBeDefined();
    await act(async () => closeBrowser?.props.onClick());
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(browser);

    const deleteBrowser = menuItems().find((item) =>
      textContent(item).includes("Delete Resource"),
    );
    expect(deleteBrowser).toBeDefined();
    await act(async () => deleteBrowser?.props.onClick());
    expect(onDelete).toHaveBeenCalledWith(browser);
    expect(
      renderer.root.findAllByProps({ "data-confirm-delete": true }),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
  });

  it("closes a rail view on middle click without selecting another view first", async () => {
    const browser = surface("browser", "one", "Browser", 0);
    const terminal = surface("terminal", "two", "Terminal", 1);
    const onClose = vi.fn<(surface: ProjectSurface) => void>();
    const onSelect =
      vi.fn<(surface: ProjectSurface, active: boolean) => void>();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = renderRail({
        activeTabKey: browser.tabKey,
        onClose,
        onSelect,
        surfaces: [browser, terminal],
      });
    });

    const railTab = renderer.root.findByProps({
      "data-dock-rail-tab": browser.tabKey,
    });
    const mouseDownPreventDefault = vi.fn();
    await act(async () =>
      railTab.props.onMouseDown({
        button: 1,
        preventDefault: mouseDownPreventDefault,
      }),
    );
    expect(mouseDownPreventDefault).toHaveBeenCalledOnce();

    const auxPreventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () =>
      railTab.props.onAuxClick({
        button: 1,
        preventDefault: auxPreventDefault,
        stopPropagation,
      }),
    );
    expect(auxPreventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(browser);

    await act(async () => renderer.unmount());
  });

  it("shows a live insertion placeholder for a cross-rail drag", async () => {
    const browser = surface("browser", "one", "Browser", 0);
    const terminal = surface("terminal", "two", "Terminal", 0);
    terminal.paneId = "pane-bottom";
    terminal.member.paneId = "pane-bottom";
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = renderRail({
        activeTabKey: browser.tabKey,
        pane: {
          id: "pane-right",
          region: "right",
        } as ProjectPaneSummary,
        surfaces: [browser],
        workspaceDndState: {
          activeDrag: {
            type: "surface",
            projectId: "project-1",
            paneId: "pane-bottom",
            tabKey: terminal.tabKey,
            label: terminal.title,
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
                tabKey: terminal.tabKey,
                targetPaneId: "pane-right",
                targetMemberPosition: 0,
              },
            },
          },
          dropTarget: {
            type: "pane-tab",
            projectId: "project-1",
            paneId: "pane-right",
            tabKey: browser.tabKey,
            memberPosition: 0,
          },
        },
      });
    });

    const placeholder = renderer.root.findByProps({
      "data-workspace-drop-placeholder": terminal.tabKey,
    });
    expect(placeholder.props["data-workspace-drop-placeholder-pane"]).toBe(
      "pane-right",
    );
    expect(placeholder.props.style).toMatchObject({ height: 40, width: 40 });

    await act(async () => renderer.unmount());
  });
});
