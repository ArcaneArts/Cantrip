import type { RunConfigurationFile } from "@cantrip/protocol/run-configuration-definitions";
import { describe, expect, it } from "vitest";

import { mutationChatLiveResources } from "../src/app/shared/live-resources.js";
import {
  auditResourceId,
  csrfExemptRoute,
  mutationAuditDescriptor,
  publicRoute,
  removedPlaintextRepositoryRoute,
  standaloneChatFeatureForbidden,
  tunnelAttachmentSocketSecret,
  validUuidPathParameter,
} from "../src/app/shared/request-policy.js";
import { runConfigurationSecretReferences } from "../src/app/shared/run-configuration-secrets.js";
import {
  createStreamedFinalTracker,
  hasFinal,
  recordFinal,
} from "../src/app/shared/streamed-final-tracker.js";
import { worktreeStatusFromGitStatus } from "../src/app/shared/worktree-status.js";

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

  it("classifies public, removed, and standalone-only routes", () => {
    expect(publicRoute("/api/auth/session")).toBe(true);
    expect(csrfExemptRoute("/api/auth/session")).toBe(true);
    expect(publicRoute("/api/projects/:projectId")).toBe(false);
    expect(
      removedPlaintextRepositoryRoute(
        "/api/projects/:projectId/worktrees/:worktreeId/git/status",
      ),
    ).toBe(true);
    expect(
      removedPlaintextRepositoryRoute(
        "/api/projects/:projectId/worktrees/:worktreeId/git/agent/drafts",
      ),
    ).toBe(false);
    expect(standaloneChatFeatureForbidden("/api/chats/:chatId/goal")).toBe(
      true,
    );
    expect(standaloneChatFeatureForbidden("/api/chats/:chatId/messages")).toBe(
      false,
    );
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

describe("worktree status projection", () => {
  it("derives worker metadata from the durable worktree and Git status", () => {
    const status = {
      branch: "feature/refactor",
      head: "abc123",
      upstream: null,
      ahead: 1,
      behind: 0,
      files: [],
      branches: [],
    };
    const worktree = {
      id: "worktree-1",
      projectSourceId: "source-1",
      projectId: "project-1",
      rootKind: "git-worktree" as const,
      workerId: "worker-1",
      name: "Feature",
      path: "/workspace/feature",
      displayPath: "/workspace/feature",
      isPrimary: false,
      isDefault: false,
      origin: "cantrip" as const,
      lifecycleState: "prunable" as const,
      branch: "stale-branch",
      head: "stale-head",
      detached: false,
      locked: true,
      lockReason: "In use",
      lastScannedAt: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };

    expect(worktreeStatusFromGitStatus(worktree, status)).toEqual({
      worktree: {
        path: "/workspace/feature",
        head: "abc123",
        branch: "feature/refactor",
        detached: false,
        isPrimary: false,
        managed: true,
        locked: true,
        lockReason: "In use",
        prunable: true,
        pruneReason: null,
        missing: false,
      },
      status,
    });
    expect(
      worktreeStatusFromGitStatus(
        {
          ...worktree,
          origin: "external",
          lifecycleState: "missing",
        },
        { ...status, branch: "", head: null },
      ).worktree,
    ).toMatchObject({
      branch: null,
      detached: true,
      managed: false,
      missing: true,
      prunable: false,
    });
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
