import type { ChatSummary, ProjectTabLayoutSummary } from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  selectedWorkspaceTabKey,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

import { useProjectSurfaceCloseCoordinator } from "./project-surface-close";

const timestamp = "2026-09-03T12:00:00.000Z";
const projectId = "project-1";
const layout: ProjectTabLayoutSummary = {
  groups: [
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
        groupId: "group-1",
        position,
        projectId,
        tabKey: `${member.tabKind}:${member.tabId}`,
        updatedAt: timestamp,
      })),
      position: 0,
      projectId,
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
  activeTabByGroup: { "group-1": "chat:agent-1" },
  destination: "surface",
  projectId,
  selectedGroupId: "group-1",
};
const closeInput = { kind: "chat", projectId, tabId: "agent-1" } as const;

function CloseHarness({ queryClient }: { queryClient: QueryClient }) {
  const [selection, setSelection] = useState(selected);
  const close = useProjectSurfaceCloseCoordinator({
    queryClient,
    setWorkspaceSelection: setSelection,
  });
  return (
    <>
      <button id="begin" onClick={() => close.begin(closeInput)} />
      <button id="commit" onClick={() => close.commit(closeInput)} />
      <button id="rollback" onClick={() => close.rollback(closeInput)} />
      <span id="pending">{[...close.pendingTabKeys].join(",")}</span>
      <span id="selected">{selectedWorkspaceTabKey(selection)}</span>
    </>
  );
}

async function renderHarness(queryClient: QueryClient) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<CloseHarness queryClient={queryClient} />);
  });
  return renderer;
}

function text(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findByProps({ id }).props.children;
}

describe("project surface close coordinator", () => {
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
        ?.groups[0]?.members.map(({ tabKey }) => tabKey),
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
    expect(
      queryClient.getQueryData<ChatSummary[]>(["chats", projectId]),
    ).toEqual([chat]);
    expect(queryClient.getQueryData(["project-tab-layout", projectId])).toEqual(
      layout,
    );

    await act(async () => renderer.unmount());
  });
});
