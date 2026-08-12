import { describe, expect, it } from "vitest";

import {
  directAttachmentTicketSchema,
  directRouteStateSchema,
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
});
