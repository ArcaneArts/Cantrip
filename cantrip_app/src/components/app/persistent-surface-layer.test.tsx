import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { PersistentSurfaceLayer } from "./persistent-surface-layer";

const surfaceProps = vi.hoisted(() => ({
  terminal: null as Record<string, unknown> | null,
  code: null as Record<string, unknown> | null,
  explorer: null as Record<string, unknown> | null,
}));

vi.mock("@/components/app/application-shell-surfaces", () => ({
  PersistentCodeViews: (props: Record<string, unknown>) => {
    surfaceProps.code = props;
    return null;
  },
  PersistentExplorerViews: (props: Record<string, unknown>) => {
    surfaceProps.explorer = props;
    return null;
  },
  PersistentTerminalViews: (props: Record<string, unknown>) => {
    surfaceProps.terminal = props;
    return null;
  },
}));

vi.mock("@/components/workspace/project-tab-bar", () => ({
  ProjectPaneTabStrip: ({ children }: { children?: ReactNode }) => children,
}));

describe("persistent surface layer", () => {
  it("places a chat CLI in its pane and removes the placement when toggled back", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const terminal = { id: "cli-one", linkedChatId: "chat-one" };
    const portalTarget = {};
    const bindings = {
      appMode: "ide",
      openExplorers: [],
      selectedProjectId: "project-1",
      terminals: { data: [terminal] },
      dockPanePresentations: [
        {
          activeSurface: { kind: "chat", entity: { id: "chat-one" } },
          focused: false,
          gridArea: "right-body",
          pane: { id: "right" },
          portalTarget,
        },
      ],
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PersistentSurfaceLayer
          bindings={{
            ...bindings,
            chatConsoleOpenChats: new Set(["chat-one"]),
          }}
        />,
      );
    });
    expect(surfaceProps.terminal?.visiblePlacements).toEqual([
      {
        terminal,
        focused: false,
        gridArea: "right-body",
        paneId: "right",
        portalTarget,
      },
    ]);
    await act(async () => {
      renderer.update(
        <PersistentSurfaceLayer
          bindings={{ ...bindings, chatConsoleOpenChats: new Set() }}
        />,
      );
    });
    expect(surfaceProps.terminal?.visiblePlacements).toEqual([]);
    await act(async () => renderer.unmount());
  });
  it("places an active sidebar preview in its pane without hiding other panes", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const previewExplorer = { id: "preview-explorer" };
    const rightExplorer = { id: "right-explorer" };
    const centerHost = {};
    const rightHost = {};
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <PersistentSurfaceLayer
          bindings={{
            appMode: "ide",
            dockPanePresentations: [
              {
                activeSurface: { entity: { id: "code" }, kind: "code" },
                focused: true,
                gridArea: "center-body",
                pane: { id: "center" },
                portalTarget: centerHost,
              },
              {
                activeSurface: {
                  entity: rightExplorer,
                  kind: "explorer",
                },
                focused: false,
                gridArea: "right-body",
                pane: { id: "right" },
                portalTarget: rightHost,
              },
            ],
            openExplorers: [],
            selectedProjectId: "project-1",
            sidebarFilePreview: {
              active: true,
              explorerId: previewExplorer.id,
              paneId: "center",
              path: "src/preview.ts",
              projectId: "project-1",
            },
            sidebarFilePreviewPaneVisible: true,
            sidebarFilePreviewVisible: true,
            sidebarPreviewExplorer: previewExplorer,
          }}
        />,
      );
    });

    expect(surfaceProps.code?.visiblePlacements).toEqual([]);
    expect(surfaceProps.explorer?.activeExplorer).toBe(previewExplorer);
    expect(surfaceProps.explorer?.visiblePlacements).toEqual([
      {
        explorer: rightExplorer,
        focused: false,
        gridArea: "right-body",
        paneId: "right",
        portalTarget: rightHost,
      },
      {
        explorer: previewExplorer,
        focused: true,
        gridArea: "center-body",
        paneId: "center",
        portalTarget: centerHost,
      },
    ]);

    await act(async () => renderer.unmount());
  });

  it("keeps a center preview mounted while a dock pane owns focus", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const previewExplorer = { id: "preview-explorer" };
    const rightExplorer = { id: "right-explorer" };
    const centerHost = {};
    const rightHost = {};
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <PersistentSurfaceLayer
          bindings={{
            appMode: "ide",
            dockPanePresentations: [
              {
                activeSurface: { entity: { id: "code" }, kind: "code" },
                focused: false,
                gridArea: "center-body",
                pane: { id: "center" },
                portalTarget: centerHost,
              },
              {
                activeSurface: {
                  entity: rightExplorer,
                  kind: "explorer",
                },
                focused: true,
                gridArea: "right-body",
                pane: { id: "right" },
                portalTarget: rightHost,
              },
            ],
            openExplorers: [],
            selectedExplorer: rightExplorer,
            selectedProjectId: "project-1",
            sidebarFilePreview: {
              active: true,
              explorerId: previewExplorer.id,
              paneId: "center",
              path: "src/preview.ts",
              projectId: "project-1",
            },
            sidebarFilePreviewPaneVisible: true,
            sidebarFilePreviewVisible: false,
            sidebarPreviewExplorer: previewExplorer,
          }}
        />,
      );
    });

    expect(surfaceProps.code?.visiblePlacements).toEqual([]);
    expect(surfaceProps.explorer?.activeExplorer).toBe(previewExplorer);
    expect(surfaceProps.explorer?.visiblePlacements).toEqual([
      {
        explorer: rightExplorer,
        focused: true,
        gridArea: "right-body",
        paneId: "right",
        portalTarget: rightHost,
      },
      {
        explorer: previewExplorer,
        focused: false,
        gridArea: "center-body",
        paneId: "center",
        portalTarget: centerHost,
      },
    ]);

    await act(async () => renderer.unmount());
  });
});
