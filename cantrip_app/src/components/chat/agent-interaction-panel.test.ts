import type { AgentInteractionRequest } from "@cantrip/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AgentInteractionPanel,
  buildUserInputResponse,
  commandDecisionResponse,
} from "./agent-interaction-panel";

describe("agent interaction response builders", () => {
  it("requires every user-input answer and maps Other values", () => {
    const payload = {
      kind: "userInput" as const,
      autoResolutionMs: null,
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Which target?",
          isOther: true,
          isSecret: false,
          options: [{ label: "Primary", description: "Use Primary" }],
        },
        {
          id: "token",
          header: "Token",
          question: "Enter the token",
          isOther: false,
          isSecret: true,
          options: null,
        },
      ],
    };
    expect(
      buildUserInputResponse(
        payload,
        { target: "__other__", token: "" },
        { target: "Secondary" },
      ),
    ).toBeNull();
    expect(
      buildUserInputResponse(
        payload,
        { target: "__other__", token: "secret" },
        { target: "Secondary" },
      ),
    ).toEqual({
      kind: "userInput",
      answers: {
        target: { answers: ["Secondary"] },
        token: { answers: ["secret"] },
      },
    });
  });

  it("includes only the amendment required by a command decision", () => {
    const payload = {
      kind: "commandExecution" as const,
      startedAtMs: 1,
      approvalId: null,
      environmentId: null,
      reason: null,
      command: "git status",
      cwd: "/repo",
      commandActions: null,
      networkApprovalContext: null,
      additionalPermissions: null,
      proposedExecpolicyAmendment: ["git", "status"],
      proposedNetworkPolicyAmendments: [
        { host: "example.com", action: "allow" as const },
      ],
      availableDecisions: ["acceptWithExecpolicyAmendment" as const],
    };
    expect(
      commandDecisionResponse(payload, "acceptWithExecpolicyAmendment"),
    ).toEqual({
      kind: "commandExecution",
      decision: "acceptWithExecpolicyAmendment",
      execpolicyAmendment: ["git", "status"],
      networkPolicyAmendment: null,
    });
    expect(commandDecisionResponse(payload, "decline")).toMatchObject({
      decision: "decline",
      execpolicyAmendment: null,
      networkPolicyAmendment: null,
    });
  });

  it("renders pending approvals on an opaque popover surface", () => {
    const request: AgentInteractionRequest = {
      id: "approval-one",
      requestKey: "approval-one",
      projectId: "project-one",
      provenance: {
        chatId: "chat-one",
        threadId: "thread-one",
        turnId: "turn-one",
        itemId: null,
        executionLaneId: null,
        workerId: "worker-one",
      },
      status: "pending",
      payload: {
        kind: "commandExecution",
        startedAtMs: 1,
        approvalId: null,
        environmentId: null,
        reason: null,
        command: "git status",
        cwd: "/repo",
        commandActions: null,
        networkApprovalContext: null,
        additionalPermissions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: ["accept", "decline"],
      },
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      expiresAt: null,
      resolvedAt: null,
      resolvedByUserId: null,
      response: null,
    };
    const markup = renderToStaticMarkup(
      createElement(AgentInteractionPanel, {
        requests: [request],
        pendingRequestId: null,
        onRespond: () => undefined,
      }),
    );

    expect(markup).toContain('data-slot="agent-interaction-card"');
    expect(markup).toContain("bg-[var(--popover-solid)]");
    expect(markup).not.toContain("bg-amber-500/5");
  });
});

describe("computer-use permission approval labels", () => {
  function permissionRequest(
    owner: "computer-use" | "codex" | undefined,
    turnId: string | null,
    reason: string | null = null,
  ): AgentInteractionRequest {
    return {
      id: "00000000-0000-4000-8000-000000000001",
      requestKey: "permission-one",
      projectId: null,
      provenance:
        owner === "computer-use"
          ? {
              owner,
              chatId: "chat-one",
              threadId: turnId ? "thread-one" : null,
              turnId,
              itemId: null,
              executionLaneId: null,
              workerId: "worker-one",
            }
          : {
              ...(owner ? { owner } : {}),
              chatId: "chat-one",
              threadId: "thread-one",
              turnId,
              itemId: null,
              executionLaneId: null,
              workerId: "worker-one",
            },
      payload: {
        kind: "permissions",
        ...(owner === "computer-use"
          ? { source: "native-computer-use" as const }
          : {}),
        startedAtMs: 1,
        environmentId: null,
        cwd: owner === "computer-use" ? null : "/repo",
        reason,
        requestedPermissions: { capture: true },
      },
      status: "pending",
      response: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: null,
      resolvedAt: null,
      resolvedByUserId: null,
    };
  }

  function renderRequest(request: AgentInteractionRequest) {
    return renderToStaticMarkup(
      createElement(AgentInteractionPanel, {
        requests: [request],
        pendingRequestId: null,
        onRespond: () => undefined,
      }),
    );
  }

  it.each([
    ["computer-use", null, "Grant once"],
    ["computer-use", "turn-one", "Grant for turn"],
    ["codex", null, "Grant for turn"],
    ["codex", "turn-one", "Grant for turn"],
    [undefined, null, "Grant for turn"],
  ] as const)(
    "labels %s approval with turn %s as %s",
    (owner, turnId, label) => {
      const markup = renderRequest(permissionRequest(owner, turnId));
      const labels = [
        ...markup.matchAll(/<button\b[^>]*>(.*?)<\/button>/g),
      ].map(([, text]) => text);
      expect(labels).toEqual([label, "Grant for session", "Deny"]);
      if (owner === "computer-use") {
        expect(markup).toContain("Computer-use approval");
        expect(markup).toContain(
          "requested access to this worker&#x27;s desktop.",
        );
        expect(markup).toContain('aria-label="Pending agent requests"');
        expect(markup).not.toContain("Codex requested additional permissions.");
      } else {
        expect(markup).toContain("Permission grant");
        expect(markup).toContain("Codex requested additional permissions.");
        expect(markup).toContain('aria-label="Pending Codex requests"');
      }
    },
  );

  it("retains the worker's specific approval reason", () => {
    const markup = renderRequest(
      permissionRequest("computer-use", null, "Capture the selected window."),
    );
    expect(markup).toContain("Capture the selected window.");
    expect(markup).not.toContain("requested access to this worker");
  });
});
