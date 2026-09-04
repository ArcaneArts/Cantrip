import type {
  ProjectBuiltInSurfaceDefinitionId,
  ProjectCapabilities,
  ProjectSurfaceLauncher,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  buildProjectSurfaceIndex,
  type ProjectSurface,
} from "@/lib/project-surface";

import { ProjectToolLaunchers } from "./project-tool-launchers";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = "2026-09-04T12:00:00.000Z";
const capabilities: ProjectCapabilities = {
  git: true,
  github: true,
  worktrees: true,
  replicas: true,
  relocation: true,
};

function launcher(
  definitionId: ProjectBuiltInSurfaceDefinitionId,
  pinned: boolean,
): ProjectSurfaceLauncher {
  return {
    id: `launcher:project-1:project-navigator:${definitionId}`,
    projectId: "project-1",
    location: "project-navigator",
    target: { kind: "definition", definitionId },
    pinned,
  };
}

function builtInSurface(
  definitionId: ProjectBuiltInSurfaceDefinitionId,
): Extract<ProjectSurface, { kind: "builtin" }> {
  const tabKey = `builtin:project-1:${definitionId}`;
  const layout: ProjectTabLayoutSummary = {
    projectId: "project-1",
    revision: 1,
    groups: [
      {
        id: `group-${definitionId}`,
        projectId: "project-1",
        title: definitionId,
        position: 0,
        anchorTabKey: tabKey,
        createdAt: timestamp,
        updatedAt: timestamp,
        members: [
          {
            tabKey,
            groupId: `group-${definitionId}`,
            projectId: "project-1",
            tabKind: "builtin",
            tabId: definitionId,
            builtInState: { definitionId, worktreeId: null },
            title: definitionId,
            position: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      },
    ],
  };
  const surface = buildProjectSurfaceIndex(layout, {
    browsers: [],
    chats: [],
    codeTabs: [],
    explorers: [],
    projectViews: [],
    terminals: [],
  }).byTabKey.get(tabKey);
  if (!surface || surface.kind !== "builtin") {
    throw new Error(`Expected ${definitionId} to resolve as a built-in tool.`);
  }
  return surface;
}

function renderLaunchers({
  projectCapabilities = capabilities,
  surfaces = [],
}: {
  projectCapabilities?: ProjectCapabilities;
  surfaces?: readonly ProjectSurface[];
} = {}) {
  const callbacks = {
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onPin: vi.fn(),
    onSelect: vi.fn(),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ProjectToolLaunchers
        capabilities={projectCapabilities}
        launchers={[
          launcher("project.overview", true),
          launcher("github.issues", false),
        ]}
        selectedTabKey={null}
        surfaces={surfaces}
        {...callbacks}
      />,
    );
  });
  return { callbacks, renderer };
}

describe("project tool launchers", () => {
  it("keeps unpinned tools out of permanent navigator rows", () => {
    const { renderer } = renderLaunchers();
    const pinned = renderer.root.findByProps({
      "aria-label": "Pinned project tools",
    });
    const catalog = renderer.root.findByProps({
      "aria-label": "Project tools catalog",
    });

    expect(
      pinned.findAllByProps({ "data-project-tool": "project.overview" }),
    ).toHaveLength(1);
    expect(
      pinned.findAllByProps({ "data-project-tool": "github.issues" }),
    ).toHaveLength(0);
    expect(
      catalog.findAllByProps({ "data-project-tool": "github.issues" }),
    ).toHaveLength(0);

    act(() => catalog.findByProps({ "aria-expanded": false }).props.onClick());
    expect(
      catalog.findAllByProps({ "data-project-tool": "github.issues" }),
    ).toHaveLength(1);
    expect(
      catalog.findAllByProps({ "data-project-tool": "project.overview" }),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it("opens a closed tool while pinning remains an isolated preference action", () => {
    const { callbacks, renderer } = renderLaunchers();
    const overview = renderer.root.findByProps({
      "data-project-tool": "project.overview",
    });

    act(() => overview.findAllByType("button")[0]!.props.onClick());
    expect(callbacks.onOpen).toHaveBeenCalledWith("project.overview");
    expect(callbacks.onSelect).not.toHaveBeenCalled();

    callbacks.onOpen.mockClear();
    act(() =>
      renderer.root
        .findByProps({ "aria-label": "Unpin Overview" })
        .props.onClick(),
    );
    expect(callbacks.onPin).toHaveBeenCalledWith("project.overview", false);
    expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it("disables an unavailable closed tool but keeps its open view focusable and closable", () => {
    const unavailableCapabilities = { ...capabilities, github: false };
    const closed = renderLaunchers({
      projectCapabilities: unavailableCapabilities,
    });
    act(() =>
      closed.renderer.root
        .findByProps({ "aria-label": "Project tools catalog" })
        .findByProps({ "aria-expanded": false })
        .props.onClick(),
    );
    const closedIssues = closed.renderer.root.findByProps({
      "data-project-tool": "github.issues",
    });
    expect(closedIssues.findAllByType("button")[0]!.props.disabled).toBe(true);
    expect(
      closed.renderer.root.findAllByProps({ "aria-label": "Close Issues" }),
    ).toHaveLength(0);
    act(() => closed.renderer.unmount());

    const surface = builtInSurface("github.issues");
    const open = renderLaunchers({
      projectCapabilities: unavailableCapabilities,
      surfaces: [surface],
    });
    act(() =>
      open.renderer.root
        .findByProps({ "aria-label": "Project tools catalog" })
        .findByProps({ "aria-expanded": false })
        .props.onClick(),
    );
    const openIssues = open.renderer.root.findByProps({
      "data-project-tool": "github.issues",
    });
    const focusButton = openIssues.findAllByType("button")[0]!;
    expect(focusButton.props.disabled).toBe(false);

    act(() => focusButton.props.onClick());
    expect(open.callbacks.onSelect).toHaveBeenCalledWith(surface.tabKey);
    expect(open.callbacks.onOpen).not.toHaveBeenCalled();

    act(() =>
      open.renderer.root
        .findByProps({ "aria-label": "Close Issues" })
        .props.onClick(),
    );
    expect(open.callbacks.onClose).toHaveBeenCalledWith(surface);
    expect(open.callbacks.onPin).not.toHaveBeenCalled();

    act(() => open.renderer.unmount());
  });
});
