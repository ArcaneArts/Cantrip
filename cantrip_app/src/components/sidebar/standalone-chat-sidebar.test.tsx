import {
  standaloneChatSummarySchema,
  type WorkerSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StandaloneChatSidebar } from "./standalone-chat-sidebar";

const chat = standaloneChatSummarySchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  contextKind: "standalone",
  projectId: null,
  experience: "agent",
  position: 0,
  status: "idle",
  activeWorkerId: "worker-a",
  activeWorktreeId: null,
  activeScratchRootId: "00000000-0000-4000-8000-000000000002",
  placementRevision: 1,
  worktreeMode: null,
  modelId: null,
  reasoningEffort: null,
  customSubagentModel: false,
  subagentModelId: null,
  subagentReasoningEffort: null,
  permissionProfileId: null,
  planMode: "default",
  hasPendingPlanQuestion: false,
  hasUnreadCompletion: true,
  automationPaused: false,
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:01:00.000Z",
  title: "Research notes",
});

describe("standalone Chat sidebar", () => {
  it("shows standalone navigation without project surfaces", () => {
    const markup = renderToStaticMarkup(
      <StandaloneChatSidebar
        archived={[]}
        archivedLoading={false}
        chats={[chat]}
        creationDisabled={false}
        creating={false}
        selectedChatId={chat.id}
        workers={[{ workerId: "worker-a", online: true } as WorkerSummary]}
        onArchive={() => undefined}
        onFork={() => undefined}
        onNewChat={() => undefined}
        onOpenSettings={() => undefined}
        onPermanentlyDelete={() => undefined}
        onRename={() => undefined}
        onRestore={() => undefined}
        onSelect={() => undefined}
        onSwitchIde={() => undefined}
      />,
    );

    expect(markup).toContain(" IDE</button>");
    expect(markup).toContain("New Chat");
    expect(markup).toContain("Research notes");
    expect(markup).toContain("Agent turn finished");
    expect(markup).toContain("Archived");
    expect(markup).toContain("Settings");
    expect(markup).not.toContain("Project files");
    expect(markup).not.toContain("Worktree");
    expect(markup).not.toContain("Terminal");
  });
});
