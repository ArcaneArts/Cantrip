import { chatSummarySchema } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatActivityStatus, ProjectOverviewTab } from "./project-chat-list";

const chat = chatSummarySchema.parse({
  id: "chat-1",
  projectId: "project-1",
  experience: "agent",
  position: 0,
  status: "idle",
  activeWorkerId: null,
  activeWorktreeId: "worktree-1",
  placementRevision: 1,
  worktreeMode: "agent-managed",
  modelId: null,
  reasoningEffort: null,
  permissionProfileId: null,
  planMode: "default",
  hasPendingPlanQuestion: false,
  hasUnreadCompletion: true,
  automationPaused: false,
  createdAt: "2026-08-22T12:00:00.000Z",
  updatedAt: "2026-08-22T12:01:00.000Z",
  title: "Agent",
});

describe("chat activity status", () => {
  it("shows a blue completion dot after the running indicator clears", () => {
    const completed = renderToStaticMarkup(<ChatActivityStatus chat={chat} />);
    const running = renderToStaticMarkup(
      <ChatActivityStatus chat={{ ...chat, status: "running" }} />,
    );

    expect(completed).toContain("bg-sky-400");
    expect(completed).toContain("Agent turn finished; open to dismiss");
    expect(running).toContain("animate-spin");
    expect(running).not.toContain("bg-sky-400");
  });
});

describe("project overview sidebar tab", () => {
  it("uses a compact Overview destination instead of the project name", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewTab
        active
        onOpenSettings={() => undefined}
        onRemove={() => undefined}
        onSelect={() => undefined}
        project={
          {
            id: "project-1",
            name: "BileTools",
            setupStatus: "ready",
          } as Parameters<typeof ProjectOverviewTab>[0]["project"]
        }
        revealDisabled={false}
      />,
    );

    expect(markup).toContain(">Overview</span>");
    expect(markup).toContain("h-8");
    expect(markup).not.toContain(">BileTools</span>");
  });
});
