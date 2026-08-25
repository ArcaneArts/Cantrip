import { describe, expect, it } from "vitest";

import {
  codeCapabilitiesSchema,
  codeProtectedAttachmentWireSchema,
  codeSessionAttachmentCreateSchema,
  codeSessionRouteBasePath,
  codeSessionRouteGrantSchema,
  parseCodeSessionRoutePath,
  codeSharedAttachmentWireSchema,
  codeTransportCandidateSchema,
  codeTransportRouteAuthorizeCommandSchema,
  codeTransportRouteAuthorizeResultSchema,
  codeTransportRouteRevokeCommandSchema,
  codeTransportRouteRevokeResultSchema,
  codeTransportRevokeCommandSchema,
  codeTransportRevokeResultSchema,
  codeTransportWireSchema,
  workerCommandSchema,
} from "../src/index.js";
import {
  tunnelContentRecordSchema,
  tunnelPublicDestinationEndpoint,
} from "../src/tunnel-content.js";

const attachmentId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const sessionIncarnationId = "44444444-4444-4444-8444-444444444444";
const transportId = "11111111-1111-4111-8111-111111111111";
const routeGrant = "A".repeat(43);
const now = "2026-08-25T12:00:00.000Z";
const lifecycleIdentity = {
  ownerId: "owner-1",
  authSessionId: "auth-session-1",
  serverId: "server-1",
  serverControlPlaneGeneration: "44444444-4444-4444-8444-444444444444",
  protectedKeyRevision: 7,
  workerProcessGeneration: "55555555-5555-4555-8555-555555555555",
};

const protectedRecord = {
  operationId: transportId,
  revision: 1,
  protectedContent: {
    formatVersion: 1,
    domain: "tunnel-content" as const,
    keyRevision: 7,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 7,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  },
};

const runtime = {
  sessionId,
  sessionIncarnationId,
  workspaceUri: "file:///workspace/project.code-workspace",
  status: "running" as const,
  editorBuild: {
    version: "1.2.3",
    upstreamRevision: "a".repeat(40),
    patchset: 1,
    fingerprint: "b".repeat(64),
  },
  processInstanceId: "code-process-1",
  bridgeConnected: true,
  dirtyEditors: [],
  workbench: {
    activeEditor: null,
    git: null,
    conflicts: [],
    savePolicy: "always" as const,
    agentStatus: "idle" as const,
  },
  startedAt: now,
  lastActivityAt: now,
  lastError: null,
};

describe("shared Code transport protocol", () => {
  it("defaults legacy worker capabilities to shared transport protocol v1", () => {
    const legacy = codeCapabilitiesSchema.parse({
      available: true,
      version: "1.2.3",
      upstreamRevision: "a".repeat(40),
      patchset: 1,
      transport: "web-proxy",
      maxSessions: 8,
      reason: null,
    });

    expect(legacy.sharedTransportProtocolVersion).toBe(1);
    expect(
      codeCapabilitiesSchema.parse({
        ...legacy,
        sharedTransportProtocolVersion: 2,
      }).sharedTransportProtocolVersion,
    ).toBe(2);
    expect(() =>
      codeCapabilitiesSchema.parse({
        ...legacy,
        sharedTransportProtocolVersion: 3,
      }),
    ).toThrow();
  });

  it("keeps the legacy protected attachment contract strict and unchanged", () => {
    const legacy = codeProtectedAttachmentWireSchema.parse({
      attachmentId: transportId,
      tunnelId: transportId,
      sessionId,
      expiresAt: now,
      runtime,
    });

    expect(Object.keys(legacy)).toEqual([
      "attachmentId",
      "tunnelId",
      "sessionId",
      "expiresAt",
      "runtime",
    ]);
    expect(() =>
      codeProtectedAttachmentWireSchema.parse({
        ...legacy,
        formatVersion: 2,
      }),
    ).toThrow();
  });

  it("binds a v2 transport candidate to its initial protected record", () => {
    expect(
      codeTransportCandidateSchema.parse({
        formatVersion: 2,
        transportId,
        protectedRecord,
      }),
    ).toMatchObject({ transportId, protectedRecord: { revision: 1 } });
    expect(() =>
      codeTransportCandidateSchema.parse({
        formatVersion: 2,
        transportId: "55555555-5555-4555-8555-555555555555",
        protectedRecord,
      }),
    ).toThrow(/transport-bound/u);
    expect(() =>
      codeTransportCandidateSchema.parse({
        formatVersion: 2,
        transportId,
        protectedRecord: { ...protectedRecord, revision: 2 },
      }),
    ).toThrow(/transport-bound/u);
  });

  it("keeps logical session leases separate from their shared transport", () => {
    const transport = codeTransportWireSchema.parse({
      formatVersion: 2,
      transportId,
      tunnelId: transportId,
      workerId: "worker-1",
      expiresAt: now,
    });
    const attachment = codeSharedAttachmentWireSchema.parse({
      formatVersion: 2,
      transport,
      session: {
        formatVersion: 2,
        attachmentId,
        transportId,
        sessionId,
        routeGrant,
        expiresAt: now,
        runtime,
      },
    });

    expect(attachment.transport.tunnelId).toBe(transportId);
    expect(attachment.session.attachmentId).not.toBe(transportId);
    expect(attachment.session.sessionId).toBe(sessionId);
    expect(() =>
      codeSharedAttachmentWireSchema.parse({
        ...attachment,
        session: {
          ...attachment.session,
          transportId: "55555555-5555-4555-8555-555555555555",
        },
      }),
    ).toThrow(/reference its transport/u);
    expect(() =>
      codeSharedAttachmentWireSchema.parse({
        ...attachment,
        session: {
          ...attachment.session,
          sessionId: "55555555-5555-4555-8555-555555555555",
        },
      }),
    ).toThrow(/runtime session/u);
  });

  it("accepts idempotent client identities without coupling them to a tunnel", () => {
    const create = codeSessionAttachmentCreateSchema.parse({
      formatVersion: 2,
      attachmentId,
      sessionId,
      appearance: "dark",
      expectedWorkerId: "worker-1",
      expectedWorktreeId: "worktree-1",
      transport: {
        formatVersion: 2,
        transportId,
        protectedRecord,
      },
    });

    expect(create.attachmentId).not.toBe(create.transport.transportId);
    expect(create.transport.transportId).toBe(transportId);
  });

  it("uses a non-UUID secret grant in a canonical session route", () => {
    expect(codeSessionRouteGrantSchema.parse(routeGrant)).toBe(routeGrant);
    expect(codeSessionRouteBasePath(routeGrant)).toBe(
      `/sessions/${routeGrant}/code`,
    );
    expect(() => codeSessionRouteGrantSchema.parse(sessionId)).toThrow();
    expect(() => codeSessionRouteBasePath("_".repeat(43))).toThrow();
    expect(
      parseCodeSessionRoutePath(`/sessions/${routeGrant}/code/editor.js?q=1`),
    ).toEqual({
      basePath: `/sessions/${routeGrant}/code`,
      routeGrant,
    });
    for (const invalid of [
      `/sessions/${routeGrant}/codeevil`,
      `/sessions/${routeGrant}//code`,
      `/sessions/${routeGrant}/code/%2e%2e/secret`,
      `/sessions/${routeGrant}%2fcode`,
      `/sessions/${sessionId}/code`,
    ]) {
      expect(parseCodeSessionRoutePath(invalid)).toBeNull();
    }
  });

  it("projects the shared encrypted destination to the existing public adapter", () => {
    const content = tunnelContentRecordSchema.parse({
      name: "Cantrip Code",
      description: null,
      source: { kind: "desktop-loopback" },
      destination: {
        kind: "worker-code-transport",
        workerId: "worker-1",
        resourceId: transportId,
      },
      dataProtection: {
        formatVersion: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 7,
        key: routeGrant,
      },
    });

    expect(tunnelPublicDestinationEndpoint(content.destination)).toEqual({
      kind: "worker-adapter",
      workerId: "worker-1",
      adapter: "code",
      resourceId: transportId,
    });
    expect(JSON.stringify(content.destination)).not.toContain(sessionId);
  });

  it("integrates strict route lifecycle commands into the worker union", () => {
    const authorize = {
      type: "code.transport.route.authorize" as const,
      ...lifecycleIdentity,
      transportId,
      attachmentId,
      sessionId,
      expectedSessionIncarnationId: sessionIncarnationId,
      routeGrant,
      expiresAt: now,
    };
    expect(codeTransportRouteAuthorizeCommandSchema.parse(authorize)).toEqual(
      authorize,
    );
    expect(workerCommandSchema.parse(authorize)).toEqual(authorize);
    expect(
      workerCommandSchema.parse({
        type: "code.transport.route.revoke",
        ...lifecycleIdentity,
        transportId,
        attachmentId,
      }),
    ).toEqual(
      codeTransportRouteRevokeCommandSchema.parse({
        type: "code.transport.route.revoke",
        ...lifecycleIdentity,
        transportId,
        attachmentId,
      }),
    );
    expect(
      workerCommandSchema.parse({
        type: "code.transport.revoke",
        ...lifecycleIdentity,
        transportId,
      }),
    ).toEqual(
      codeTransportRevokeCommandSchema.parse({
        type: "code.transport.revoke",
        ...lifecycleIdentity,
        transportId,
      }),
    );
    expect(() =>
      workerCommandSchema.parse({ ...authorize, routeGrant: sessionId }),
    ).toThrow();
    expect(() =>
      codeTransportRouteAuthorizeCommandSchema.parse({
        ...authorize,
        sessionUuidAsAuthorization: true,
      }),
    ).toThrow();
    expect(
      codeTransportRouteAuthorizeResultSchema.parse({
        ...lifecycleIdentity,
        transportId,
        attachmentId,
        sessionId,
        sessionIncarnationId,
        authorized: true,
        expiresAt: now,
      }),
    ).toEqual({
      ...lifecycleIdentity,
      transportId,
      attachmentId,
      sessionId,
      sessionIncarnationId,
      authorized: true,
      expiresAt: now,
    });
    expect(
      codeTransportRouteRevokeResultSchema.parse({
        ...lifecycleIdentity,
        transportId,
        attachmentId,
        revoked: true,
      }),
    ).toEqual({
      ...lifecycleIdentity,
      transportId,
      attachmentId,
      revoked: true,
    });
    expect(
      codeTransportRevokeResultSchema.parse({
        ...lifecycleIdentity,
        transportId,
        revoked: true,
      }),
    ).toEqual({ ...lifecycleIdentity, transportId, revoked: true });
    expect(() =>
      codeTransportRouteAuthorizeResultSchema.parse({
        transportId,
        attachmentId,
        sessionId,
        sessionIncarnationId,
        authorized: false,
        expiresAt: now,
      }),
    ).toThrow();
  });
});
