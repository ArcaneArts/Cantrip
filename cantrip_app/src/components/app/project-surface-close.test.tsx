import type { ChatSummary, ProjectTabLayoutSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { closeProjectSurfaceView } from "@/lib/api";
import type { ProjectSurface } from "@/lib/project-surface";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";

import {
  selectedWorkspaceTabKey,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

import {
  useProjectSurfaceCloseCoordinator,
  useProjectSurfaceViewOperations,
} from "./project-surface-close";

vi.mock("@/lib/api", () => ({ closeProjectSurfaceView: vi.fn() }));

const timestamp = "2026-09-03T12:00:00.000Z";
const projectId = "project-1";
const layout: ProjectTabLayoutSummary = {
  panes: [
    {
      anchorTabKey: "chat:agent-1",
      createdAt: timestamp,
      id: "group-1",
      members: [
        { tabKind: "chat" as const, tabId: "agent-1", title: "Agent" },
        {
          tabKind: "terminal" as const,
          tabId: "terminal-1",
          title: "Terminal",
        },
      ].map((member, position) => ({
        ...member,
        createdAt: timestamp,
        paneId: "group-1",
        position,
        projectId,
        tabKey: `${member.tabKind}:${member.tabId}`,
        updatedAt: timestamp,
      })),
      position: 0,
      projectId,
      region: "center",
      title: "Agent",
      updatedAt: timestamp,
    },
  ],
  projectId,
  revision: 1,
};
const chat: ChatSummary = {
  activeWorkerId: "worker-1",
  activeWorktreeId: "worktree-1",
  automationPaused: false,
  createdAt: timestamp,
  experience: "agent",
  hasPendingPlanQuestion: false,
  hasUnreadCompletion: false,
  id: "agent-1",
  modelId: null,
  permissionProfileId: null,
  placementRevision: 1,
  planMode: "default",
  position: 0,
  projectId,
  reasoningEffort: null,
  status: "idle",
  title: "Agent",
  updatedAt: timestamp,
  worktreeMode: "agent-managed",
};
const selected: WorkspaceSelection = {
  activeTabByPane: { "group-1": "chat:agent-1" },
  destination: "surface",
  focusedPaneId: "group-1",
  projectId,
};
const closeInput = { kind: "chat", projectId, tabId: "agent-1" } as const;

type CoordinatorWorkspace = Parameters<
  typeof useProjectSurfaceCloseCoordinator
>[0]["workspace"];
function CloseHarness({
  queryClient,
  workspace,
}: {
  queryClient: QueryClient;
  workspace?: CoordinatorWorkspace;
}) {
  const [selection, setSelection] = useState(selected);
  const close = useProjectSurfaceCloseCoordinator({
    queryClient,
    setWorkspaceSelection: setSelection,
    workspace,
  });
  return (
    <>
      <button id="begin" onClick={() => close.begin(closeInput)} />
      <button id="commit" onClick={() => close.commit(closeInput)} />
      <button
        id="commit-view"
        onClick={() =>
          close.commitView(closeInput, {
            ...layout,
            revision: layout.revision + 1,
            panes: layout.panes.map((pane) => ({
              ...pane,
              members: pane.members.filter(
                ({ tabKey }) => tabKey !== "chat:agent-1",
              ),
            })),
          })
        }
      />
      <button id="rollback" onClick={() => close.rollback(closeInput)} />
      <button
        id="switch-project"
        onClick={() =>
          setSelection({
            activeTabByPane: {},
            destination: "overview",
            focusedPaneId: null,
            projectId: "project-2",
          })
        }
      />
      <span id="pending">{[...close.pendingTabKeys].join(",")}</span>
      <span id="project">{selection.projectId}</span>
      <span id="selected">{selectedWorkspaceTabKey(selection)}</span>
    </>
  );
}

async function renderHarness(
  queryClient: QueryClient,
  workspace?: CoordinatorWorkspace,
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <CloseHarness queryClient={queryClient} workspace={workspace} />,
    );
  });
  return renderer;
}

function text(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findByProps({ id }).props.children;
}

describe("project surface close coordinator", () => {
  it.each([
    "ready",
    "initializing",
    "failed-read",
    "other-project",
    "disposed",
  ] as const)(
    "does not apply legacy placement or selection during owned deletion (%s)",
    async (mode) => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(["chats", projectId], [chat]);
      queryClient.setQueryData(["project-tab-layout", projectId], layout);
      const refresh = vi.fn(async () => {
        if (mode === "failed-read") throw new Error("offline");
      });
      const workspace =
        mode === "initializing"
          ? null
          : {
              refresh,
              getSnapshot: () => ({
                disposed: mode === "disposed",
                authoritative: {
                  projectId: mode === "other-project" ? "project-2" : projectId,
                },
              }),
            };
      const renderer = await renderHarness(queryClient, workspace);
      for (const id of ["begin", "rollback", "commit"]) {
        await act(async () =>
          renderer.root.findByProps({ id }).props.onClick(),
        );
        expect(text(renderer, "selected")).toBe("chat:agent-1");
        expect(text(renderer, "pending")).toBe("");
        expect(
          queryClient.getQueryData(["project-tab-layout", projectId]),
        ).toEqual(layout);
        expect(queryClient.getQueryData(["chats", projectId])).toEqual(
          id === "commit" ? [] : [chat],
        );
      }
      expect(queryClient.getQueryData(["chats", projectId])).toEqual([]);
      expect(refresh).toHaveBeenCalledTimes(
        mode === "ready" || mode === "failed-read" ? 1 : 0,
      );
      await act(async () =>
        renderer.root.findByProps({ id: "commit-view" }).props.onClick(),
      );
      expect(
        queryClient.getQueryData(["project-tab-layout", projectId]),
      ).toEqual(layout);
      expect(text(renderer, "selected")).toBe("chat:agent-1");
      expect(refresh).toHaveBeenCalledTimes(
        mode === "ready" || mode === "failed-read" ? 2 : 0,
      );
      await act(async () => renderer.unmount());
    },
  );
  it("hides the closing tab and selects its successor before committing", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["chats", projectId], [chat]);
    queryClient.setQueryData(["project-tab-layout", projectId], layout);
    const renderer = await renderHarness(queryClient);

    await act(async () =>
      renderer.root.findByProps({ id: "begin" }).props.onClick(),
    );

    expect(text(renderer, "pending")).toBe("chat:agent-1");
    expect(text(renderer, "selected")).toBe("terminal:terminal-1");
    expect(
      queryClient.getQueryData<ChatSummary[]>(["chats", projectId]),
    ).toEqual([chat]);

    await act(async () => renderer.unmount());
  });

  it("commits successful deletion to both authoritative client caches", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["chats", projectId], [chat]);
    queryClient.setQueryData(["project-tab-layout", projectId], layout);
    const renderer = await renderHarness(queryClient);

    await act(async () =>
      renderer.root.findByProps({ id: "begin" }).props.onClick(),
    );
    await act(async () =>
      renderer.root.findByProps({ id: "commit" }).props.onClick(),
    );

    expect(text(renderer, "pending")).toBe("");
    expect(
      queryClient.getQueryData<ChatSummary[]>(["chats", projectId]),
    ).toEqual([]);
    expect(
      queryClient
        .getQueryData<ProjectTabLayoutSummary>([
          "project-tab-layout",
          projectId,
        ])
        ?.panes[0]?.members.map(({ tabKey }) => tabKey),
    ).toEqual(["terminal:terminal-1"]);

    await act(async () => renderer.unmount());
  });

  it("commits Close View without removing the resource cache", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["chats", projectId], [chat]);
    queryClient.setQueryData(["project-tab-layout", projectId], layout);
    const renderer = await renderHarness(queryClient);

    await act(async () =>
      renderer.root.findByProps({ id: "begin" }).props.onClick(),
    );
    await act(async () =>
      renderer.root.findByProps({ id: "commit-view" }).props.onClick(),
    );

    expect(text(renderer, "pending")).toBe("");
    expect(
      queryClient.getQueryData<ChatSummary[]>(["chats", projectId]),
    ).toEqual([chat]);
    expect(
      queryClient
        .getQueryData<ProjectTabLayoutSummary>([
          "project-tab-layout",
          projectId,
        ])
        ?.panes[0]?.members.map(({ tabKey }) => tabKey),
    ).toEqual(["terminal:terminal-1"]);

    await act(async () => renderer.unmount());
  });

  it("restores visibility without changing caches when deletion fails", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["chats", projectId], [chat]);
    queryClient.setQueryData(["project-tab-layout", projectId], layout);
    const renderer = await renderHarness(queryClient);

    await act(async () =>
      renderer.root.findByProps({ id: "begin" }).props.onClick(),
    );
    await act(async () =>
      renderer.root.findByProps({ id: "rollback" }).props.onClick(),
    );

    expect(text(renderer, "pending")).toBe("");
    expect(text(renderer, "selected")).toBe("chat:agent-1");
    expect(
      queryClient.getQueryData<ChatSummary[]>(["chats", projectId]),
    ).toEqual([chat]);
    expect(queryClient.getQueryData(["project-tab-layout", projectId])).toEqual(
      layout,
    );

    await act(async () => renderer.unmount());
  });

  it("does not reconcile another project's active selection on completion", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["chats", projectId], [chat]);
    queryClient.setQueryData(["project-tab-layout", projectId], layout);
    const renderer = await renderHarness(queryClient);

    await act(async () =>
      renderer.root.findByProps({ id: "begin" }).props.onClick(),
    );
    await act(async () =>
      renderer.root.findByProps({ id: "switch-project" }).props.onClick(),
    );
    await act(async () =>
      renderer.root.findByProps({ id: "commit-view" }).props.onClick(),
    );

    expect(text(renderer, "project")).toBe("project-2");
    expect(text(renderer, "selected")).toBeNull();
    await act(async () => renderer.unmount());
  });
});

describe("project surface view operations", () => {
  it.each(["success", "failure"] as const)(
    "does not let a duplicate close cancel the original reservation: %s",
    async (outcome) => {
      const queryClient = new QueryClient();
      let settle!: () => void;
      const pending = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const dispatch = vi.fn(async () => {
        await pending;
        if (outcome === "failure") throw new Error("close failed");
        return {};
      });
      const controller = {
        getSnapshot: () => ({ authoritative: { projectId } }),
        dispatch,
      } as unknown as WorkspaceCommandClient;
      const finalize = vi.fn();
      const beforeClose = vi.fn(async () => finalize);
      const onCloseError = vi.fn();
      const surfaceClose = {
        begin: vi.fn(),
        commit: vi.fn(),
        commitView: vi.fn(),
        rollback: vi.fn(),
        pendingTabKeys: new Set<string>(),
      };
      const surface = {
        kind: "chat",
        projectId,
        tabId: "resource",
        tabKey: "view",
        view: { id: "view" },
      } as ProjectSurface;
      let operations!: ReturnType<typeof useProjectSurfaceViewOperations>;
      function Probe() {
        operations = useProjectSurfaceViewOperations({
          queryClient,
          beforeClose,
          onCloseError,
          surfaceClose,
          workspace: { controller },
        });
        return null;
      }
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <QueryClientProvider client={queryClient}>
            <Probe />
          </QueryClientProvider>,
        );
      });
      let first!: Promise<unknown>;
      await act(async () => {
        first = operations.closeSurfaceViewMutation
          .mutateAsync(surface)
          .catch((error) => error);
      });
      await act(async () => {
        await expect(
          operations.closeSurfaceViewMutation.mutateAsync(surface),
        ).rejects.toThrow("already closing");
      });
      expect(beforeClose).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(onCloseError).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
      await act(async () => {
        settle();
        await first;
      });
      expect(finalize).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      expect(onCloseError).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
      if (outcome === "failure") {
        dispatch.mockResolvedValueOnce({});
        await act(async () => {
          await operations.closeSurfaceViewMutation.mutateAsync(surface);
        });
        expect(finalize).toHaveBeenCalledOnce();
      }
      await act(async () => renderer.unmount());
      queryClient.clear();
    },
  );
  it.each(["success", "close-failed", "cleanup-failed"] as const)(
    "finalizes the captured renderer only after confirmed close: %s",
    async (outcome) => {
      const queryClient = new QueryClient();
      const order: string[] = [];
      const failure = new Error(outcome);
      const finalize = vi.fn(async () => {
        order.push("cleanup");
        if (outcome === "cleanup-failed") throw failure;
      });
      const dispatch = vi.fn(async () => {
        order.push("close");
        if (outcome === "close-failed") throw failure;
        return {};
      });
      const controller = {
        getSnapshot: () => ({ authoritative: { projectId } }),
        dispatch,
      } as unknown as WorkspaceCommandClient;
      const surfaceClose = {
        begin: vi.fn(),
        commit: vi.fn(),
        commitView: vi.fn(),
        rollback: vi.fn(),
        pendingTabKeys: new Set<string>(),
      };
      const surface = {
        kind: "chat",
        projectId,
        tabId: "resource",
        tabKey: "view",
        view: { id: "view" },
      } as ProjectSurface;
      const onCloseError = vi.fn();
      const onCloseCleanupError = vi.fn();
      let operations!: ReturnType<typeof useProjectSurfaceViewOperations>;
      function Probe() {
        operations = useProjectSurfaceViewOperations({
          beforeClose: async () => {
            order.push("prepare");
            return finalize;
          },
          onCloseError,
          onCloseCleanupError,
          queryClient,
          surfaceClose,
          workspace: { controller },
        });
        return null;
      }
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <QueryClientProvider client={queryClient}>
            <Probe />
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        const operation =
          operations.closeSurfaceViewMutation.mutateAsync(surface);
        if (outcome === "success") await operation;
        else await expect(operation).rejects.toBe(failure);
      });
      expect(order).toEqual(
        outcome === "close-failed"
          ? ["prepare", "close"]
          : ["prepare", "close", "cleanup"],
      );
      expect(onCloseError).toHaveBeenCalledTimes(
        outcome === "close-failed" ? 1 : 0,
      );
      expect(onCloseCleanupError).toHaveBeenCalledTimes(
        outcome === "cleanup-failed" ? 1 : 0,
      );
      expect(surfaceClose.rollback).not.toHaveBeenCalled();
      await act(async () => renderer.unmount());
      queryClient.clear();
    },
  );
  it.each(["builtin", "chat"] as const)(
    "closes the owned %s tab identity without legacy resource-keyed hiding or cache writes",
    async (kind) => {
      const queryClient = new QueryClient();
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const dispatch = vi.fn().mockResolvedValue({});
      const controller = {
        getSnapshot: () => ({ authoritative: { projectId } }),
        dispatch,
      } as unknown as WorkspaceCommandClient;
      const surfaceClose = {
        begin: vi.fn(),
        commit: vi.fn(),
        commitView: vi.fn(),
        rollback: vi.fn(),
        pendingTabKeys: new Set<string>(),
      };
      const surface = {
        kind,
        projectId,
        tabId: kind === "builtin" ? "project.tasks" : "agent-resource",
        tabKey: "independent-view",
        view: { id: "independent-view" },
      } as ProjectSurface;
      let operations!: ReturnType<typeof useProjectSurfaceViewOperations>;
      function Probe() {
        operations = useProjectSurfaceViewOperations({
          queryClient,
          surfaceClose,
          workspace: { controller },
        });
        return null;
      }
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <QueryClientProvider client={queryClient}>
            <Probe />
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        await operations.closeSurfaceViewMutation.mutateAsync(surface);
      });
      expect(dispatch).toHaveBeenCalledWith({
        type: "close-tab",
        tabId: "independent-view",
      });
      expect(surfaceClose.begin).not.toHaveBeenCalled();
      expect(surfaceClose.commitView).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      await act(async () => renderer.unmount());
      queryClient.clear();
    },
  );
  it("hides the view before awaiting Explorer attachment retirement", async () => {
    const order: string[] = [];
    const queryClient = new QueryClient();
    queryClient.setQueryData(["project-tab-layout", projectId], layout);
    vi.mocked(closeProjectSurfaceView).mockImplementation(async () => {
      order.push("server-close");
      return {
        disposition: "closed",
        layout: { ...layout, panes: [], revision: 2 },
        viewId: "explorer:explorer-1",
      };
    });
    const surfaceClose = {
      begin: vi.fn(() => order.push("hide-view")),
      commit: vi.fn(),
      commitView: vi.fn(),
      pendingTabKeys: new Set<string>(),
      rollback: vi.fn(),
    };
    const surface = {
      kind: "explorer",
      projectId,
      tabId: "explorer-1",
      view: { id: "explorer:explorer-1" },
    } as ProjectSurface;

    function ViewCloseHarness() {
      const operations = useProjectSurfaceViewOperations({
        beforeClose: async () => {
          order.push("retire-attachment");
        },
        queryClient,
        surfaceClose,
      });
      return (
        <button
          id="close-view"
          onClick={() => operations.closeSurfaceViewMutation.mutate(surface)}
        />
      );
    }

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient}>
          <ViewCloseHarness />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      renderer.root.findByProps({ id: "close-view" }).props.onClick();
      await vi.waitFor(() =>
        expect(closeProjectSurfaceView).toHaveBeenCalledOnce(),
      );
    });

    expect(order).toEqual(["hide-view", "retire-attachment", "server-close"]);
    expect(surfaceClose.commitView).toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
});
