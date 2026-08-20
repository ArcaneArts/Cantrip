import { describe, expect, it } from "vitest";

import {
  browserTunnelRequestSchema,
  tunnelAttachmentCreateResultSchema,
  tunnelAttachmentInitializeSchema,
  tunnelAttachmentReadySchema,
  tunnelAttachmentSummarySchema,
  tunnelManagedRegistrationSchema,
  tunnelSummarySchema,
  tunnelUserCreateSchema,
} from "../src/index.js";

const now = "2026-08-11T12:00:00.000Z";

describe("tunnel protocol", () => {
  it("carries an explicit discovered-service worker into Browser tunneling", () => {
    expect(
      browserTunnelRequestSchema.parse({
        protocol: "http",
        host: "127.0.0.1",
        port: 5173,
        workerId: "worker-b",
      }),
    ).toEqual({
      protocol: "http",
      host: "127.0.0.1",
      port: 5173,
      workerId: "worker-b",
    });
    expect(() =>
      browserTunnelRequestSchema.parse({
        protocol: "http",
        host: "example.com",
        port: 5173,
      }),
    ).toThrow();
    expect(() =>
      browserTunnelRequestSchema.parse({
        protocol: "http",
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173/private",
      }),
    ).toThrow();
  });

  it("keeps user-created routes on desktop loopback and an explicit worker", () => {
    expect(
      tunnelUserCreateSchema.parse({
        name: "Local Vite",
        protocolHint: "http-websocket",
        destination: {
          kind: "worker-tcp",
          workerId: "worker-b",
          port: 5173,
        },
      }),
    ).toEqual({
      name: "Local Vite",
      description: null,
      projectId: null,
      protocolHint: "http-websocket",
      destination: {
        kind: "worker-tcp",
        workerId: "worker-b",
        host: "127.0.0.1",
        port: 5173,
      },
    });
    expect(() =>
      tunnelUserCreateSchema.parse({
        name: "Unsafe route",
        protocolHint: "tcp",
        source: { kind: "worker-listener", workerId: "worker-a", port: 9000 },
        destination: {
          kind: "worker-tcp",
          workerId: "worker-b",
          host: "0.0.0.0",
          port: 9001,
        },
      }),
    ).toThrow();
  });

  it("reserves explicit worker-to-worker placement for managed callers", () => {
    expect(
      tunnelManagedRegistrationSchema.parse({
        name: "Future worker relay",
        projectId: "project-organizer",
        origin: "system",
        management: "managed-durable",
        protocolHint: "tcp",
        source: {
          kind: "worker-listener",
          workerId: "worker-a",
          host: "127.0.0.1",
          port: 4000,
        },
        destination: {
          kind: "worker-tcp",
          workerId: "worker-b",
          host: "127.0.0.1",
          port: 5000,
        },
        managedBy: { kind: "system", id: "future-relay-1" },
      }),
    ).toMatchObject({
      projectId: "project-organizer",
      source: { workerId: "worker-a" },
      destination: { workerId: "worker-b" },
    });
    expect(() =>
      tunnelManagedRegistrationSchema.parse({
        name: "Mismatched adapter",
        origin: "code",
        management: "managed-durable",
        protocolHint: "http",
        source: { kind: "server-http", adapter: "code" },
        destination: {
          kind: "worker-adapter",
          workerId: "worker-b",
          adapter: "project-share",
          resourceId: "share-1",
        },
        managedBy: { kind: "project-share", id: "share-1" },
      }),
    ).toThrow(/origin|adapter/i);
  });

  it("requires coherent managed ownership and attachment endpoints", () => {
    const summary = {
      id: "tunnel-1",
      name: "Cantrip Code",
      description: null,
      projectId: "project-1",
      position: 0,
      origin: "code",
      management: "managed-durable",
      protocolHint: "http-websocket",
      source: { kind: "server-http", adapter: "code" },
      destination: {
        kind: "worker-adapter",
        workerId: "worker-1",
        adapter: "code",
        resourceId: "code-1",
      },
      managedBy: { kind: "code", id: "code-1" },
      desiredState: "started",
      status: "active",
      lastError: null,
      activeConnectionCount: 0,
      bytesFromSource: 0,
      bytesToSource: 0,
      attachments: [],
      capabilities: {
        canEdit: false,
        canDelete: false,
        canStart: false,
        canStop: false,
        canAttach: false,
        canOpenOwner: true,
      },
      createdAt: now,
      updatedAt: now,
    } as const;
    expect(tunnelSummarySchema.parse(summary)).toEqual(summary);
    expect(() =>
      tunnelSummarySchema.parse({ ...summary, managedBy: null }),
    ).toThrow(/owning resource/i);

    const attachment = {
      id: "attachment-1",
      tunnelId: "tunnel-1",
      kind: "desktop-loopback",
      clientId: "desktop-1",
      localHost: "127.0.0.1",
      localPort: 43123,
      status: "active",
      activeConnectionCount: 0,
      bytesFromSource: 0,
      bytesToSource: 0,
      lastError: null,
      expiresAt: null,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    } as const;
    expect(tunnelAttachmentSummarySchema.parse(attachment)).toEqual(attachment);
    expect(() =>
      tunnelAttachmentSummarySchema.parse({
        ...attachment,
        clientId: null,
      }),
    ).toThrow(/client identity/i);
    expect(
      tunnelAttachmentSummarySchema.parse({
        ...attachment,
        localHost: null,
        localPort: null,
        status: "starting",
      }),
    ).toMatchObject({ localHost: null, localPort: null });
    expect(() =>
      tunnelAttachmentSummarySchema.parse({
        ...attachment,
        localPort: null,
      }),
    ).toThrow(/together/i);
  });

  it("keeps attachment credentials out of the connection URL", () => {
    const created = tunnelAttachmentCreateResultSchema.parse({
      attachmentId: "attachment-1",
      tunnelId: "tunnel-1",
      secret: "a".repeat(43),
      connectPath: "/api/tunnel-attachments/attachment-1/connect",
      secretExpiresAt: now,
      expiresAt: "2026-08-12T00:00:00.000Z",
    });
    expect(created.connectPath).not.toContain(created.secret);
    expect(
      tunnelAttachmentInitializeSchema.parse({
        type: "initialize",
        clientId: "desktop-1",
        localHost: "127.0.0.1",
        localPort: 43_123,
      }),
    ).toMatchObject({ localPort: 43_123 });
    expect(
      tunnelAttachmentReadySchema.parse({
        type: "ready",
        attachmentId: created.attachmentId,
        tunnelId: created.tunnelId,
        sourceEndpointId: "desktop:desktop-1:attachment-1",
        destinationEndpointId: "worker:worker-1",
        expiresAt: created.expiresAt,
      }),
    ).toMatchObject({ type: "ready" });
  });
});
