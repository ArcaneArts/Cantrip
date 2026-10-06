import type {
  AgentInteractionRequest,
  ChatSummary,
  TaskDetail,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskImplementationDashboard } from "./task-implementation-dashboard";
import { TaskInteractionRequests } from "./task-interaction-requests";

const chat = {
  id: "task-chat",
  projectId: "project",
  status: "running",
} as ChatSummary;
const queryKey = ["agent-requests", chat.id, "pending"];
function request(): AgentInteractionRequest {
  return {
    id: "approval-1",
    requestKey: "approval-1",
    projectId: "project",
    provenance: {
      chatId: chat.id,
      threadId: "thread",
      turnId: "turn",
      itemId: "command",
      executionLaneId: null,
      workerId: "worker",
    },
    status: "pending",
    response: null,
    resolvedByUserId: null,
    resolvedAt: null,
    expiresAt: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    payload: {
      kind: "commandExecution",
      startedAtMs: 1,
      approvalId: null,
      environmentId: null,
      reason: "Remove the completed task worktree after syncing main.",
      command: "git worktree remove /tmp/completed-task",
      cwd: "/repo",
      commandActions: null,
      networkApprovalContext: null,
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ["accept", "decline"],
    },
  };
}
function render(
  requests: AgentInteractionRequest[],
  status = chat.status,
  error?: Error,
  dashboard = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKey, requests);
  if (error)
    client
      .getQueryCache()
      .find({ queryKey })!
      .setState({ error, status: "error" });
  const currentChat = { ...chat, status };
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {dashboard ? (
        <TaskImplementationDashboard
          chat={currentChat}
          initialTask={
            {
              state: "implementing",
              planGoalEnabled: false,
              briefMarkdown: "Task brief",
            } as TaskDetail
          }
        />
      ) : (
        <TaskInteractionRequests chat={currentChat} />
      )}
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}

describe("Task interaction requests", () => {
  it("shows the specific reason, command, and scoped approval buttons even before the chat status updates", () => {
    const markup = render([request()]);
    expect(markup).toContain("Action required");
    expect(markup).toContain(
      "Remove the completed task worktree after syncing main.",
    );
    expect(markup).toContain("git worktree remove /tmp/completed-task");
    expect(markup).toContain("Working directory: /repo");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Deny");
    expect(markup).not.toContain("Allow for session");
  });

  it("keeps approval controls above the implementation activity", () => {
    const markup = render([request()], "waiting-for-approval", undefined, true);
    expect(markup).toContain("Needs approval");
    expect(markup.indexOf("Action required")).toBeLessThan(
      markup.indexOf("Latest activity"),
    );
  });

  it("does not render empty sections when the task has no pending requests", () => {
    expect(render([])).toBe("");
    expect(render([{ ...request(), status: "interrupted" }])).toBe("");
  });

  it("does not expose another chat's request", () => {
    const foreign = request();
    foreign.provenance = { ...foreign.provenance, chatId: "other-chat" };
    expect(render([foreign])).toBe("");
  });

  it("offers refresh when the chat is waiting but the request details have not arrived", () => {
    const markup = render([], "waiting-for-approval");
    expect(markup).toContain(
      "No pending requests. Refresh to check for updates.",
    );
    expect(markup).toContain("Refresh requests");
    expect(markup).not.toContain("Allow once");
  });

  it("shows fetch errors and a retry control rather than hiding the problem", () => {
    const markup = render(
      [],
      "waiting-for-approval",
      new Error("Request details could not be loaded"),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Request details could not be loaded");
    expect(markup).toContain("Refresh requests");
  });

  it("shows MCP approval descriptions and an Accept button", () => {
    const approval = request();
    approval.payload = {
      kind: "mcpElicitation",
      serverName: "cantrip",
      mode: "form",
      message: "Remove the completed worktree from this project?",
      requestedSchema: null,
      url: null,
      elicitationId: null,
      metadata: null,
    };
    const markup = render([approval]);
    expect(markup).toContain(
      "Remove the completed worktree from this project?",
    );
    expect(markup).toContain("Accept");
    expect(markup).toContain("Decline");
  });
});
