import { describe, expect, it } from "vitest";

import {
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
});
