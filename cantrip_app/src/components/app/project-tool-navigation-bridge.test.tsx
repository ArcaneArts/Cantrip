import type {
  ProjectTabLayoutSummary,
  ProjectViewSummary,
} from "@cantrip/protocol";
import { StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useProjectToolNavigationBridge,
  type ProjectToolNavigationBridgeInput,
} from "./project-tool-navigation-bridge";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const timestamp = "2026-10-08T12:00:00.000Z";
function view(id: string, worktreeId = "root-one"): ProjectViewSummary {
  return {
    id,
    projectId: "project-one",
    kind: "history",
    title: "History",
    worktreeId,
    position: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
function layout(revision = 1): ProjectTabLayoutSummary {
  return {
    projectId: "project-one",
    revision,
    panes: [
      {
        id: "center-one",
        projectId: "project-one",
        title: "Center",
        region: "center",
        position: 0,
        anchorTabKey: "view:history-center",
        createdAt: timestamp,
        updatedAt: timestamp,
        members: [
          {
            projectId: "project-one",
            paneId: "center-one",
            tabKey: "view:history-center",
            tabKind: "history",
            tabId: "history-center",
            title: "History",
            position: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      },
    ],
  };
}
function fixture(overrides: Partial<ProjectToolNavigationBridgeInput> = {}) {
  return {
    isPopout: false,
    selectedProjectId: "project-one",
    selectedBuiltInDefinitionId: null,
    destination: "overview" as const,
    section: "history" as const,
    worktreeId: "root-one",
    layout: layout(),
    layoutReady: true,
    views: [view("history-dock"), view("history-center")],
    viewsReady: true,
    openBuiltInSurface: vi.fn(),
    openSurface: vi.fn(),
    createSurface: vi.fn(),
    ...overrides,
  };
}
function Bridge({ input }: { input: ProjectToolNavigationBridgeInput }) {
  useProjectToolNavigationBridge(input);
  return null;
}
let renderer: TestRenderer.ReactTestRenderer | undefined;
async function mount(input: ProjectToolNavigationBridgeInput, strict = false) {
  await act(async () => {
    renderer = TestRenderer.create(
      strict ? (
        <StrictMode>
          <Bridge input={input} />
        </StrictMode>
      ) : (
        <Bridge input={input} />
      ),
    );
  });
}
async function update(input: ProjectToolNavigationBridgeInput) {
  await act(async () => {
    renderer!.update(<Bridge input={input} />);
  });
}
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
});

describe("restoring project tool navigation", () => {
  it.each(["layout", "views"])(
    "waits for %s first hydration and reuses the existing History resource",
    async (first) => {
      const input = fixture({
        layoutReady: false,
        viewsReady: false,
        views: undefined,
      });
      await mount(input);
      const partial = {
        ...input,
        layoutReady: first === "layout",
        viewsReady: first === "views",
        views: first === "views" ? [view("history-center")] : undefined,
      };
      await update(partial);
      expect(input.createSurface).not.toHaveBeenCalled();
      await update({
        ...input,
        layoutReady: true,
        viewsReady: true,
        views: [view("history-center")],
      });
      expect(input.createSurface).not.toHaveBeenCalled();
      expect(input.openSurface).toHaveBeenCalledWith("project-one", {
        kind: "entity",
        definitionId: "project.git-history",
        resourceId: "history-center",
      });
    },
  );
  it("restores one matching center resource without collapsing independent dock views on Strict Mode and remount", async () => {
    const input = fixture();
    await mount(input, true);
    expect(input.createSurface).not.toHaveBeenCalled();
    expect(input.openSurface).toHaveBeenCalledTimes(1);
    expect(input.openSurface).toHaveBeenCalledWith("project-one", {
      kind: "entity",
      definitionId: "project.git-history",
      resourceId: "history-center",
    });
    await act(async () => {
      renderer!.unmount();
    });
    renderer = undefined;
    await mount(input);
    expect(input.createSurface).not.toHaveBeenCalled();
    expect(input.views!.map((v) => v.id)).toEqual([
      "history-dock",
      "history-center",
    ]);
  });
  it("does not create again as the creation itself advances layout revisions", async () => {
    const input = fixture({ views: [] });
    await mount(input);
    await update({ ...input, layout: layout(2) });
    await update({ ...input, layout: layout(3) });
    expect(input.createSurface).toHaveBeenCalledTimes(1);
    expect(input.createSurface).toHaveBeenCalledWith({
      kind: "history",
      projectId: "project-one",
      worktreeId: "root-one",
    });
  });
  it("does not reuse a History resource for a different checkout or project", async () => {
    const input = fixture({
      views: [
        view("different-root", "root-two"),
        { ...view("foreign"), projectId: "other-project" },
      ],
    });
    await mount(input);
    expect(input.createSurface).toHaveBeenCalledTimes(1);
    expect(input.openSurface).not.toHaveBeenCalled();
  });

  it("reopens a retained resource after leaving the destination instead of creating another", async () => {
    const input = fixture({ views: [view("retained")] });
    await mount(input);
    await update({ ...input, destination: "surface" });
    await update(input);
    expect(input.createSurface).not.toHaveBeenCalled();
    expect(input.openSurface).toHaveBeenCalledTimes(2);
    expect(input.openSurface).toHaveBeenLastCalledWith("project-one", {
      kind: "entity",
      definitionId: "project.git-history",
      resourceId: "retained",
    });
  });

  it("handles a new requested checkout while the previous navigation is settling", async () => {
    const input = fixture({ views: [] });
    await mount(input);
    await update({ ...input, worktreeId: "root-two", layout: layout(2) });
    expect(input.createSurface).toHaveBeenCalledTimes(2);
    expect(input.createSurface).toHaveBeenNthCalledWith(2, {
      kind: "history",
      projectId: "project-one",
      worktreeId: "root-two",
    });
  });
  it("keeps Tasks on its built-in opening path without requiring view inventory", async () => {
    const input = fixture({
      section: "tasks",
      viewsReady: false,
      views: undefined,
    });
    await mount(input);
    expect(input.createSurface).not.toHaveBeenCalled();
    expect(input.openBuiltInSurface).toHaveBeenCalledWith(
      "project-one",
      "tasks",
    );
  });
  it.each([
    { isPopout: true },
    { destination: "surface" as const },
    { selectedBuiltInDefinitionId: "project.tasks" },
    { section: "overview" as const },
  ])("leaves unrelated navigation untouched: %j", async (overrides) => {
    const input = fixture(overrides);
    await mount(input);
    expect(input.createSurface).not.toHaveBeenCalled();
    expect(input.openSurface).not.toHaveBeenCalled();
    expect(input.openBuiltInSurface).not.toHaveBeenCalled();
  });
});
