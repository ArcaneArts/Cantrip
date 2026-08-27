import type { RunConfigurationFile } from "@cantrip/protocol/run-configuration-definitions";
import { describe, expect, it } from "vitest";

import { mutationChatLiveResources } from "../src/app/shared/live-resources.js";
import {
  auditResourceId,
  mutationAuditDescriptor,
  tunnelAttachmentSocketSecret,
  validUuidPathParameter,
} from "../src/app/shared/request-policy.js";
import { runConfigurationSecretReferences } from "../src/app/shared/run-configuration-secrets.js";
import {
  createStreamedFinalTracker,
  hasFinal,
  recordFinal,
} from "../src/app/shared/streamed-final-tracker.js";

describe("application request policy helpers", () => {
  it("validates UUID route parameters without accepting partial values", () => {
    expect(validUuidPathParameter("0190A1B2-C3D4-7E5F-8A90-123456789ABC")).toBe(
      true,
    );
    expect(
      validUuidPathParameter("prefix-0190a1b2-c3d4-7e5f-8a90-123456789abc"),
    ).toBe(false);
  });

  it("prefers bearer authorization and otherwise reads the tunnel protocol", () => {
    expect(
      tunnelAttachmentSocketSecret({
        authorization: "Bearer authorization-secret",
        "sec-websocket-protocol": "cantrip-tunnel-v1.protocol-secret",
      }),
    ).toBe("authorization-secret");
    expect(
      tunnelAttachmentSocketSecret({
        "sec-websocket-protocol":
          "unrelated, cantrip-tunnel-v1.protocol-secret, another",
      }),
    ).toBe("protocol-secret");
  });

  it("keeps audit descriptor precedence and read exemptions", () => {
    expect(
      mutationAuditDescriptor("POST", "/api/projects/:projectId/git/status"),
    ).toEqual({
      action: "git.operation-requested",
      resourceType: "project",
    });
    expect(
      mutationAuditDescriptor("GET", "/api/projects/:projectId/git/status"),
    ).toBeNull();
  });

  it("keeps audit resource identifier priority", () => {
    const request = {
      params: { projectId: "project-1", workerId: "worker-1" },
    } as unknown as Parameters<typeof auditResourceId>[0];

    expect(auditResourceId(request)).toBe("worker-1");
  });
});

describe("chat mutation live resources", () => {
  it("invalidates goal state only for the goal mutation route", () => {
    expect(mutationChatLiveResources("/api/chats/:chatId/goal")).toEqual([
      "chat-goal",
    ]);
    expect(mutationChatLiveResources("/api/chats/:chatId/messages")).toEqual(
      [],
    );
  });
});

describe("streamed final tracking", () => {
  it("matches either turn identity or normalized final text", () => {
    const tracker = createStreamedFinalTracker();
    recordFinal(tracker, "turn-1", "  finished  ");

    expect(hasFinal(tracker, "turn-1", "different")).toBe(true);
    expect(hasFinal(tracker, "turn-2", "finished")).toBe(true);
    expect(hasFinal(tracker, "turn-2", "   ")).toBe(true);
    expect(hasFinal(createStreamedFinalTracker(), null, "")).toBe(false);
  });
});

describe("run configuration secret references", () => {
  it("deduplicates and sorts base and platform override secrets", () => {
    const document = {
      environment: {
        secrets: [{ secret: "zeta" }, { secret: "alpha" }],
      },
      platformOverrides: {
        darwin: {
          environment: {
            secrets: [{ secret: "middle" }, { secret: "alpha" }],
          },
        },
      },
    } as unknown as RunConfigurationFile;

    expect(runConfigurationSecretReferences(document)).toEqual([
      "alpha",
      "middle",
      "zeta",
    ]);
  });
});
