import { describe, expect, it } from "vitest";

import {
  directAttachmentTicketSchema,
  directCapabilityPrepareCommandSchema,
  directRouteStateSchema,
  directTunnelPrepareRequestSchema,
  workerHeartbeatSchema,
} from "../src/index.js";

describe("direct data plane protocol", () => {
  it("defaults older worker heartbeats to an unavailable broker", () => {
    const worker = workerHeartbeatSchema.parse({
      workerId: "worker-1",
      name: "Worker",
      platform: "darwin",
      architecture: "arm64",
      codexVersion: null,
      startedAt: new Date().toISOString(),
    });
    expect(worker.directBroker).toEqual({ available: false });
  });

  it("binds one ticket to its complete authorization context", () => {
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    expect(
      directAttachmentTicketSchema.parse({
        broker: {
          available: true,
          protocol: "ws-v1",
          loopbackHost: "127.0.0.1",
          loopbackPort: 43123,
          instanceId: crypto.randomUUID(),
          publicKey: "a".repeat(43),
          fingerprint: "b".repeat(64),
        },
        binding: {
          capabilityId: crypto.randomUUID(),
          ownerId: "owner-1",
          authSessionId: "session-1",
          workerId: "worker-1",
          resourceKind: "terminal",
          resourceId: "terminal-1",
          attachmentId: "attachment-1",
          channels: ["control", "stream"],
          expiresAt,
          leaseExpiresAt: expiresAt,
        },
        secret: "c".repeat(43),
      }).binding,
    ).toMatchObject({
      ownerId: "owner-1",
      authSessionId: "session-1",
      workerId: "worker-1",
      resourceKind: "terminal",
      channels: ["control", "stream"],
    });
    expect(directRouteStateSchema.options).toEqual([
      "probing",
      "local-direct",
      "relayed",
      "degraded",
      "failed",
    ]);
  });

  it("accepts only an optional UUID diagnostic trace on direct tunnel preparation", () => {
    const diagnosticTraceId = crypto.randomUUID();
    expect(directTunnelPrepareRequestSchema.parse(undefined)).toEqual({});
    expect(directTunnelPrepareRequestSchema.parse({})).toEqual({});
    expect(
      directTunnelPrepareRequestSchema.parse({ diagnosticTraceId }),
    ).toEqual({ diagnosticTraceId });
    expect(
      directTunnelPrepareRequestSchema.safeParse({
        diagnosticTraceId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      directTunnelPrepareRequestSchema.safeParse({
        diagnosticTraceId,
        capabilityId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it("keeps the diagnostic trace at the top level of worker prepare commands", () => {
    const diagnosticTraceId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    const command = directCapabilityPrepareCommandSchema.parse({
      type: "direct.capability.prepare",
      diagnosticTraceId,
      binding: {
        capabilityId: crypto.randomUUID(),
        ownerId: "owner-1",
        authSessionId: "session-1",
        workerId: "worker-1",
        resourceKind: "tunnel",
        resourceId: "tunnel-1",
        attachmentId: "attachment-1",
        channels: ["tunnel-data"],
        expiresAt,
        leaseExpiresAt: expiresAt,
      },
      secret: "c".repeat(43),
      tunnelRoute: null,
    });

    expect(command.diagnosticTraceId).toBe(diagnosticTraceId);
    expect(command.binding).not.toHaveProperty("diagnosticTraceId");
  });
});
