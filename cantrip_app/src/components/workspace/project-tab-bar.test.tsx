import { DndContext } from "@dnd-kit/core";
import {
  chatSummarySchema,
  projectTabMemberSummarySchema,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";

import { ProjectTabBar } from "./project-tab-bar";

const now = "2026-08-23T12:00:00.000Z";

function chatSurface(options: {
  running?: boolean;
  unreadCompletion?: boolean;
}): ProjectSurface {
  const chat = chatSummarySchema.parse({
    id: "chat-1",
    projectId: "project-1",
    experience: "agent",
    position: 0,
    status: options.running ? "running" : "idle",
    activeWorkerId: null,
    activeWorktreeId: "worktree-1",
    placementRevision: 1,
    worktreeMode: "agent-managed",
    modelId: null,
    reasoningEffort: null,
    permissionProfileId: null,
    planMode: "default",
    hasPendingPlanQuestion: false,
    hasUnreadCompletion: options.unreadCompletion ?? false,
    automationPaused: false,
    createdAt: now,
    updatedAt: now,
    title: "Agent",
  });
  const member = projectTabMemberSummarySchema.parse({
    tabKey: `chat:${chat.id}`,
    groupId: "group-1",
    projectId: chat.projectId,
    tabKind: "chat",
    tabId: chat.id,
    title: chat.title,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });
  return {
    entity: chat,
    groupId: member.groupId,
    kind: "chat",
    member,
    projectId: chat.projectId,
    tabId: chat.id,
    tabKey: member.tabKey,
    title: chat.title,
  };
}

function renderTabs(surface: ProjectSurface) {
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

describe("project tab bar chat activity", () => {
  it("shows the running and unread-completion states on top tabs", () => {
    const running = renderTabs(chatSurface({ running: true }));
    const completed = renderTabs(chatSurface({ unreadCompletion: true }));

    expect(running).toContain("animate-spin");
    expect(running).not.toContain("bg-sky-400");
    expect(completed).toContain("bg-sky-400");
    expect(completed).toContain("Agent turn finished; open to dismiss");
  });
});
