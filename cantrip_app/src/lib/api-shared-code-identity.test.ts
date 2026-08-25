import type { CodeSharedAttachmentWire } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  assertCreatedExplorerCodeSessionIdentity,
  assertRenewedExplorerCodeSessionIdentity,
} from "./api";

function attachment(transportId: string): CodeSharedAttachmentWire {
  const now = "2026-08-25T12:00:00.000Z";
  const sessionId = "33333333-3333-4333-8333-333333333333";
  return {
    formatVersion: 2,
    transport: {
      expiresAt: now,
      formatVersion: 2,
      protectedKeyRevision: 7,
      securityScopeId: "66666666-6666-4666-8666-666666666666",
      serverControlPlaneGeneration:
        "77777777-7777-4777-8777-777777777777",
      serverId: "server-1",
      transportId,
      tunnelId: transportId,
      workerId: "worker-1",
      workerProcessGeneration: "88888888-8888-4888-8888-888888888888",
    },
    session: {
      attachmentId: "22222222-2222-4222-8222-222222222222",
      expiresAt: now,
      formatVersion: 2,
      routeGrant: "A".repeat(43),
      runtime: {
        bridgeConnected: true,
        dirtyEditors: [],
        editorBuild: {
          fingerprint: "b".repeat(64),
          patchset: 1,
          upstreamRevision: "a".repeat(40),
          version: "1.2.3",
        },
        lastActivityAt: now,
        lastError: null,
        processInstanceId: "code-process-1",
        sessionId,
        sessionIncarnationId:
          "44444444-4444-4444-8444-444444444444",
        startedAt: now,
        status: "running",
        workbench: {
          activeEditor: null,
          agentStatus: "idle",
          conflicts: [],
          git: null,
          savePolicy: "always",
        },
        workspaceUri: "file:///workspace/project.code-workspace",
      },
      sessionId,
      transportId,
    },
  };
}

describe("shared Explorer Code response identity", () => {
  it("accepts the existing shared root when this tab proposed another candidate", () => {
    const winningRootId = "11111111-1111-4111-8111-111111111111";
    const losingCandidateId = "99999999-9999-4999-8999-999999999999";
    expect(losingCandidateId).not.toBe(winningRootId);

    expect(() =>
      assertCreatedExplorerCodeSessionIdentity(attachment(winningRootId), {
        attachmentId: "22222222-2222-4222-8222-222222222222",
        serverId: "server-1",
        sessionId: "33333333-3333-4333-8333-333333333333",
        workerId: "worker-1",
      }),
    ).not.toThrow();
  });

  it("still rejects changed logical, worker, or server identity", () => {
    const wire = attachment("11111111-1111-4111-8111-111111111111");
    expect(() =>
      assertCreatedExplorerCodeSessionIdentity(wire, {
        attachmentId: "22222222-2222-4222-8222-222222222222",
        serverId: "server-2",
        sessionId: "33333333-3333-4333-8333-333333333333",
        workerId: "worker-1",
      }),
    ).toThrow(/changed logical identity/u);
  });

  it.each([
    ["transport worker", (wire: CodeSharedAttachmentWire) => {
      wire.transport.workerId = "worker-2";
    }],
    ["security scope", (wire: CodeSharedAttachmentWire) => {
      wire.transport.securityScopeId =
        "99999999-9999-4999-8999-999999999999";
    }],
    ["server", (wire: CodeSharedAttachmentWire) => {
      wire.transport.serverId = "server-2";
    }],
    ["control plane", (wire: CodeSharedAttachmentWire) => {
      wire.transport.serverControlPlaneGeneration =
        "99999999-9999-4999-8999-999999999999";
    }],
    ["key revision", (wire: CodeSharedAttachmentWire) => {
      wire.transport.protectedKeyRevision += 1;
    }],
    ["worker process", (wire: CodeSharedAttachmentWire) => {
      wire.transport.workerProcessGeneration =
        "99999999-9999-4999-8999-999999999999";
    }],
    ["session incarnation", (wire: CodeSharedAttachmentWire) => {
      wire.session.runtime.sessionIncarnationId =
        "99999999-9999-4999-8999-999999999999";
    }],
  ] as const)("rejects a renewed lease with changed %s identity", (_name, mutate) => {
    const previous = attachment("11111111-1111-4111-8111-111111111111");
    const renewed = structuredClone(previous);
    mutate(renewed);

    expect(() =>
      assertRenewedExplorerCodeSessionIdentity(previous, renewed, "server-1"),
    ).toThrow(/lease changed identity/u);
  });
});
