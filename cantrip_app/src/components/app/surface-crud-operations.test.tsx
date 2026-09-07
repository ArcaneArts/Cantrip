import type { ChatSummary, ProjectTabLayoutSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  selectedWorkspaceTabKey,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

const api = vi.hoisted(() => ({
  deleteChat: vi.fn(),
  deleteExplorer: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/run-configuration-api", () => ({
  operateRunConfigurationRuntime: vi.fn(),
}));

import { useProjectSurfaceCloseCoordinator } from "./project-surface-close";
import {
  useChatDeleteOperation,
  useExplorerSurfaceOperations,
} from "./surface-crud-operations";
import type { ExplorerLifecycleActions } from "../explorer/explorer-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = "2026-09-03T12:00:00.000Z";
const projectId = "project-1";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function DeleteHarness({ queryClient }: { queryClient: QueryClient }) {
  const [selection, setSelection] = useState<WorkspaceSelection>({
    activeTabByPane: { "group-1": "chat:agent-1" },
    destination: "surface" as const,
    focusedPaneId: "group-1",
    projectId,
  });
  const surfaceClose = useProjectSurfaceCloseCoordinator({
    queryClient,
    setWorkspaceSelection: setSelection,
  });
  const mutation = useChatDeleteOperation({
    queryClient,
    selectedProjectId: projectId,
    setChatConsoleOpen: vi.fn(),
    setProjectTaskChatIds: vi.fn(),
    setTaskChatViewIds: vi.fn(),
    surfaceClose,
  });
  return (
    <>
      <button id="close" onClick={() => mutation.mutate(chat.id)} />
      <span id="pending">{[...surfaceClose.pendingTabKeys].join(",")}</span>
      <span id="selected">{selectedWorkspaceTabKey(selection)}</span>
    </>
  );
}

function ExplorerDeleteHarness({
  actions,
  queryClient,
}: {
  actions: ExplorerLifecycleActions;
  queryClient: QueryClient;
}) {
  const [selection, setSelection] = useState<WorkspaceSelection>({
    activeTabByPane: { "group-1": "explorer:explorer-1" },
    destination: "surface",
    focusedPaneId: "group-1",
    projectId,
  });
  const surfaceClose = useProjectSurfaceCloseCoordinator({
    queryClient,
    setWorkspaceSelection: setSelection,
  });
  const explorerLifecycleRef = useRef(
    new Map<string, ExplorerLifecycleActions>([["explorer-1", actions]]),
  );
  const { deleteExplorerMutation } = useExplorerSurfaceOperations({
    explorerLifecycleRef,
    queryClient,
    selectedProjectId: projectId,
    surfaceClose,
  });
  return (
    <>
      <button
        id="close-explorer"
        onClick={() => deleteExplorerMutation.mutate("explorer-1")}
      />
      <span id="pending-explorer">
        {[...surfaceClose.pendingTabKeys].join(",")}
      </span>
      <span id="selected-explorer">{selectedWorkspaceTabKey(selection)}</span>
    </>
  );
}

async function renderHarness(queryClient: QueryClient) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <DeleteHarness queryClient={queryClient} />
      </QueryClientProvider>,
    );
  });
  return renderer;
}

function text(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findByProps({ id }).props.children;
}

describe("immediate project surface deletion", () => {
  beforeEach(() => {
    api.deleteChat.mockReset();
    api.deleteExplorer.mockReset();
  });

  it("hides and switches tabs while the backend deletion is unresolved", async () => {
    const deletion = deferred<void>();
    api.deleteChat.mockReturnValue(deletion.promise);
    const queryClient = new QueryClient();
    queryClient.setQueryData(["chats", projectId], [chat]);
    queryClient.setQueryData(["project-tab-layout", projectId], layout);
    const renderer = await renderHarness(queryClient);

    act(() => renderer.root.findByProps({ id: "close" }).props.onClick());
    await act(async () => Promise.resolve());

    expect(api.deleteChat.mock.calls[0]?.[0]).toBe(chat.id);
    expect(text(renderer, "pending")).toBe("chat:agent-1");
    expect(text(renderer, "selected")).toBe("terminal:terminal-1");
    expect(queryClient.getQueryData(["chats", projectId])).toEqual([chat]);

    await act(async () => {
      deletion.resolve();
      await deletion.promise;
    });
    expect(text(renderer, "pending")).toBe("");
    expect(queryClient.getQueryData(["chats", projectId])).toEqual([]);
    await act(async () => renderer.unmount());
  });

  it("starts Explorer teardown before hiding its mounted editor", async () => {
    const preparation = deferred<void>();
    const actions: ExplorerLifecycleActions = {
      cancelClose: vi.fn(),
      dirty: false,
      flushViewState: vi.fn().mockResolvedValue(true),
      prepareClose: vi.fn(() => preparation.promise),
      reconcile: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(true),
    };
    api.deleteExplorer.mockResolvedValue(undefined);
    const queryClient = new QueryClient();
    queryClient.setQueryData(["project-tab-layout", projectId], {
      ...layout,
      panes: layout.panes.map((pane) => ({
        ...pane,
        anchorTabKey: "explorer:explorer-1",
        members: pane.members.map((member, index) =>
          index === 0
            ? {
                ...member,
                tabId: "explorer-1",
                tabKey: "explorer:explorer-1",
                tabKind: "explorer" as const,
                title: "Explorer",
              }
            : member,
        ),
      })),
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient}>
          <ExplorerDeleteHarness actions={actions} queryClient={queryClient} />
        </QueryClientProvider>,
      );
    });

    act(() =>
      renderer.root.findByProps({ id: "close-explorer" }).props.onClick(),
    );
    await act(async () => Promise.resolve());

    expect(actions.prepareClose).toHaveBeenCalledTimes(1);
    expect(text(renderer, "pending-explorer")).toBe("explorer:explorer-1");
    expect(text(renderer, "selected-explorer")).toBe("terminal:terminal-1");
    expect(api.deleteExplorer).not.toHaveBeenCalled();

    await act(async () => {
      preparation.resolve();
      await preparation.promise;
    });
    await vi.waitFor(() => expect(api.deleteExplorer).toHaveBeenCalledOnce());
    expect(actions.prepareClose).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
});
