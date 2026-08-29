import type { ProtectedTunnelContentRecord } from "@cantrip/protocol/tunnel-content";
import { describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import {
  ProjectShareStateStaleError,
  ProjectShareTunnelBroker,
} from "../src/project-shares/tunnel.js";
import { TunnelStreamBroker } from "../src/tunnels/broker.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const tunnelId = "11111111-1111-4111-8111-111111111111";
const protectedRecord: ProtectedTunnelContentRecord = {
  operationId: tunnelId,
  revision: 1,
  protectedContent: {
    formatVersion: 1,
    domain: "tunnel-content",
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  },
};

describe("protected project share control plane", () => {
  it("passes only opaque setup content through the server", async () => {
    const request = vi.fn().mockResolvedValue({
      accepted: true,
      shareId: tunnelId,
    });
    const bridge = {
      isConnected: (workerId: string) => workerId === "worker-1",
      request,
    } as unknown as WorkerCommandBus;
    const registerManagedTunnel = vi.fn().mockResolvedValue({ id: tunnelId });
    const repository = {
      getManagedTunnel: vi.fn().mockResolvedValue(null),
      registerManagedTunnel,
    } as unknown as ServerRepository;
    const streamBroker = new TunnelStreamBroker();
    const broker = new ProjectShareTunnelBroker(bridge);
    broker.configureControlPlane(repository, streamBroker, () => undefined);

    const attachment = await broker.open({
      ownerId: "owner-1",
      projectId: "project-1",
      protectedRecord,
      tunnelId,
      workerId: "worker-1",
    });

    expect(attachment).toMatchObject({
      attachmentId: tunnelId,
      projectId: "project-1",
      tunnelId,
    });
    expect(request).toHaveBeenCalledWith(
      "worker-1",
      {
        type: "project.share.open",
        shareId: tunnelId,
        protectedRecord,
        standaloneRoot: null,
      },
      expect.any(Object),
    );
    expect(JSON.stringify(request.mock.calls)).not.toContain('"root":"');
    expect(JSON.stringify(request.mock.calls)).not.toContain("password");
    expect(registerManagedTunnel).toHaveBeenCalledWith(
      "owner-1",
      expect.objectContaining({
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-adapter",
          workerId: "worker-1",
          adapter: "project-share",
          resourceId: tunnelId,
        },
      }),
      { id: tunnelId, protectedRecord },
    );

    await broker.close();
    streamBroker.close();
  });

  it("binds standalone Chat shares to an opaque managed resource", async () => {
    const request = vi.fn().mockResolvedValue({
      accepted: true,
      shareId: tunnelId,
    });
    const bridge = {
      isConnected: () => true,
      request,
    } as unknown as WorkerCommandBus;
    const registerManagedTunnel = vi.fn().mockResolvedValue({ id: tunnelId });
    const repository = {
      getManagedTunnel: vi.fn().mockResolvedValue(null),
      registerManagedTunnel,
    } as unknown as ServerRepository;
    const streamBroker = new TunnelStreamBroker();
    const broker = new ProjectShareTunnelBroker(bridge);
    broker.configureControlPlane(repository, streamBroker, () => undefined);

    const attachment = await broker.open({
      ownerId: "owner-1",
      projectId: null,
      managedResourceId: "chat:22222222-2222-4222-8222-222222222222",
      standaloneRoot: {
        chatId: "22222222-2222-4222-8222-222222222222",
        rootId: "33333333-3333-4333-8333-333333333333",
      },
      protectedRecord,
      tunnelId,
      workerId: "worker-1",
    });

    expect(attachment).toMatchObject({
      attachmentId: tunnelId,
      projectId: null,
      tunnelId,
    });
    expect(registerManagedTunnel).toHaveBeenCalledWith(
      "owner-1",
      expect.objectContaining({
        projectId: null,
        managedBy: {
          kind: "project-share",
          id: "chat:22222222-2222-4222-8222-222222222222",
        },
      }),
      { id: tunnelId, protectedRecord },
    );
    expect(JSON.stringify(request.mock.calls)).not.toContain('"root":"');

    expect(request).toHaveBeenCalledWith(
      "worker-1",
      expect.objectContaining({
        standaloneRoot: {
          chatId: "22222222-2222-4222-8222-222222222222",
          rootId: "33333333-3333-4333-8333-333333333333",
        },
      }),
      expect.any(Object),
    );

    await broker.close();
    streamBroker.close();
  });

  it("types stale tunnel identities and protected revisions for route recovery", async () => {
    const bridge = {
      isConnected: () => true,
      request: vi.fn(),
    } as unknown as WorkerCommandBus;
    const repository = {
      getManagedTunnel: vi.fn().mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
        protectedRecord,
      }),
    } as unknown as ServerRepository;
    const streamBroker = new TunnelStreamBroker();
    const broker = new ProjectShareTunnelBroker(bridge);
    broker.configureControlPlane(repository, streamBroker, () => undefined);

    await expect(
      broker.open({
        ownerId: "owner-1",
        projectId: "project-1",
        protectedRecord,
        tunnelId,
        workerId: "worker-1",
      }),
    ).rejects.toBeInstanceOf(ProjectShareStateStaleError);

    repository.getManagedTunnel = vi.fn().mockResolvedValue({
      id: tunnelId,
      protectedRecord,
    });
    await expect(
      broker.open({
        ownerId: "owner-1",
        projectId: "project-1",
        protectedRecord: {
          ...protectedRecord,
          operationId: "33333333-3333-4333-8333-333333333333",
        },
        tunnelId,
        workerId: "worker-1",
      }),
    ).rejects.toBeInstanceOf(ProjectShareStateStaleError);

    expect(bridge.request).not.toHaveBeenCalled();
    await broker.close();
    streamBroker.close();
  });
});
