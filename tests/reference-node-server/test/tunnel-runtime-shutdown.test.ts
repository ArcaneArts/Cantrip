import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
  ServerRepository,
  TunnelAttachmentAuthorization,
} from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import { TunnelRuntimeManager } from "../src/tunnels/runtime.js";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
class Socket extends EventEmitter {
  bufferedAmount = 0;
  readyState = 1;
  close() {
    if (this.readyState > 1) return;
    this.readyState = 3;
    this.emit("close");
  }
  send() {}
  ping() {}
}
const authorization = {
  attachmentId: "attachment",
  clientId: "client",
  destination: { kind: "worker-tcp", workerId: "worker" },
  expiresAt: new Date(Date.now() + 60000),
  ownerId: "owner",
  origin: "user",
  projectId: null,
  protectedRecord: {
    operationId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    protectedContent: {},
  },
  secretExpiresAt: new Date(Date.now() + 30000),
  tunnelId: "tunnel",
} as unknown as TunnelAttachmentAuthorization;
function runtime(repository: Partial<ServerRepository>) {
  const bridge = {
    isConnected: () => true,
    subscribeWorkerDisconnect: () => () => {},
    subscribeTunnelDataPlaneFrames: () => () => {},
    sendTunnelDataPlaneFrame: () => true,
  } as unknown as WorkerCommandBus;
  return new TunnelRuntimeManager(
    repository as ServerRepository,
    bridge,
    () => {},
  );
}
describe("tunnel shutdown database ownership", () => {
  it("drains late activation and its fenced offline write after socket close", async () => {
    const activation = deferred<Date>(),
      offline = deferred<boolean>();
    const repository = {
      activateDesktopTunnelAttachment: vi.fn(() => activation.promise),
      markDesktopTunnelAttachmentOffline: vi.fn(() => offline.promise),
    };
    const manager = runtime(repository),
      socket = new Socket();
    const attaching = manager.attach(socket, authorization, {
      type: "initialize",
      clientId: "client",
    });
    void attaching.catch(() => {});
    await vi.waitFor(() =>
      expect(repository.activateDesktopTunnelAttachment).toHaveBeenCalledOnce(),
    );
    manager.close();
    let drained = false;
    const draining = manager.drained().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    const activated = new Date();
    activation.resolve(activated);
    await vi.waitFor(() =>
      expect(
        repository.markDesktopTunnelAttachmentOffline,
      ).toHaveBeenCalledOnce(),
    );
    expect(repository.markDesktopTunnelAttachmentOffline).toHaveBeenCalledWith(
      authorization.attachmentId,
      authorization.secretExpiresAt,
      activated,
    );
    expect(drained).toBe(false);
    offline.resolve(true);
    await expect(attaching).rejects.toThrow(
      "Tunnel attachment disconnected while activating.",
    );
    await draining;
    expect(drained).toBe(true);
  });
  it("drains offline cleanup already admitted by a transport close", async () => {
    const offline = deferred<boolean>();
    const repository = {
      activateDesktopTunnelAttachment: vi.fn(async () => new Date()),
      markDesktopTunnelAttachmentOffline: vi.fn(() => offline.promise),
    };
    const manager = runtime(repository),
      socket = new Socket();
    await manager.attach(socket, authorization, {
      type: "initialize",
      clientId: "client",
    });
    socket.close();
    expect(
      repository.markDesktopTunnelAttachmentOffline,
    ).toHaveBeenCalledOnce();
    manager.close();
    let drained = false;
    const draining = manager.drained().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    offline.resolve(true);
    await draining;
    expect(drained).toBe(true);
  });
});
