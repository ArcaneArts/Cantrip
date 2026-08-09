import { describe, expect, it, vi } from "vitest";

import {
  RemoteSurfaceManager,
  type RemoteSurfaceAdapter,
  type RemoteSurfaceSession,
} from "../src/remote-surface-manager.js";

const attachCommand = {
  type: "surface.attach" as const,
  surfaceId: "surface-1",
  attachmentId: "attachment-1",
  projectId: "project-1",
  configuration: {
    kind: "browser" as const,
    initialUrl: "https://example.com/",
    profileId: null,
  },
  preferredTransport: "websocket" as const,
  viewport: { width: 1_280, height: 720, devicePixelRatio: 2 },
  desktopStream: null,
};

describe("RemoteSurfaceManager", () => {
  it("routes ordered frames through a reusable worker-owned session", async () => {
    const handleFrame = vi.fn();
    const attach = vi.fn();
    const detach = vi.fn();
    const updateConfiguration = vi.fn();
    let emit:
      | ((
          attachmentId: string,
          channel: "frame",
          payload: Uint8Array,
        ) => boolean)
      | undefined;
    const session: RemoteSurfaceSession = {
      configuration: attachCommand.configuration,
      transport: "websocket",
      attach,
      close: vi.fn(),
      detach,
      handleFrame,
      resume: vi.fn(),
      suspend: vi.fn(),
      updateConfiguration,
    };
    const adapter: RemoteSurfaceAdapter = {
      async open(_command, send) {
        emit = send as typeof emit;
        return session;
      },
    };
    const manager = new RemoteSurfaceManager({ browser: adapter });
    const outbound = vi.fn(() => true);
    manager.setFrameEmitter(outbound);

    await expect(manager.attach(attachCommand)).resolves.toEqual({
      accepted: true,
      transport: "websocket",
    });
    expect(attach).toHaveBeenCalledWith({
      id: "attachment-1",
      viewport: attachCommand.viewport,
    });

    await manager.handleFrame(
      {
        protocolVersion: 1,
        surfaceId: "surface-1",
        attachmentId: "attachment-1",
        sequence: 4,
        channel: "control",
      },
      new Uint8Array([1]),
    );
    await manager.handleFrame(
      {
        protocolVersion: 1,
        surfaceId: "surface-1",
        attachmentId: "attachment-1",
        sequence: 3,
        channel: "control",
      },
      new Uint8Array([2]),
    );
    expect(handleFrame).toHaveBeenCalledTimes(1);

    await manager.configure("surface-1", {
      kind: "browser",
      initialUrl: "https://cantrip.art/",
      profileId: null,
    });
    expect(updateConfiguration).toHaveBeenCalledWith({
      kind: "browser",
      initialUrl: "https://cantrip.art/",
      profileId: null,
    });

    emit?.("attachment-1", "frame", new Uint8Array([9, 8]));
    expect(outbound).toHaveBeenCalledWith(
      expect.objectContaining({
        surfaceId: "surface-1",
        attachmentId: "attachment-1",
        sequence: 0,
        channel: "frame",
      }),
      new Uint8Array([9, 8]),
    );

    await manager.detach("surface-1", "attachment-1");
    expect(detach).toHaveBeenCalledWith("attachment-1");
  });

  it("serializes concurrent attachments while a surface is opening", async () => {
    const attach = vi.fn();
    const session = {
      configuration: attachCommand.configuration,
      transport: "websocket" as const,
      attach,
      close: vi.fn(),
      detach: vi.fn(),
      handleFrame: vi.fn(),
      resume: vi.fn(),
      suspend: vi.fn(),
    } satisfies RemoteSurfaceSession;
    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const open = vi.fn(async () => {
      await openGate;
      return session;
    });
    const manager = new RemoteSurfaceManager({ browser: { open } });

    const first = manager.attach(attachCommand);
    const second = manager.attach({
      ...attachCommand,
      attachmentId: "attachment-2",
    });
    releaseOpen?.();
    await Promise.all([first, second]);

    expect(open).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenCalledWith({
      id: "attachment-1",
      viewport: attachCommand.viewport,
    });
    expect(attach).toHaveBeenCalledWith({
      id: "attachment-2",
      viewport: attachCommand.viewport,
    });
  });

  it("rejects kinds for which the worker has no adapter", async () => {
    const manager = new RemoteSurfaceManager();
    await expect(manager.attach(attachCommand)).rejects.toThrow(
      /does not support browser/i,
    );
  });

  it("enforces the worker session limit", async () => {
    const session = {
      configuration: attachCommand.configuration,
      transport: "websocket" as const,
      attach() {},
      close() {},
      detach() {},
      handleFrame() {},
      resume() {},
      suspend() {},
    } satisfies RemoteSurfaceSession;
    const manager = new RemoteSurfaceManager(
      { browser: { open: async () => session } },
      1,
    );
    await manager.attach(attachCommand);
    await expect(
      manager.attach({
        ...attachCommand,
        surfaceId: "surface-2",
        attachmentId: "attachment-2",
      }),
    ).rejects.toThrow(/limit of 1/i);
  });

  it("bounds independent client attachments to one surface", async () => {
    const session = {
      configuration: attachCommand.configuration,
      transport: "websocket" as const,
      attach() {},
      close() {},
      detach() {},
      handleFrame() {},
      resume() {},
      suspend() {},
    } satisfies RemoteSurfaceSession;
    const manager = new RemoteSurfaceManager({
      browser: { open: async () => session },
    });
    for (let index = 1; index <= 4; index += 1) {
      await manager.attach({
        ...attachCommand,
        attachmentId: `attachment-${index}`,
      });
    }
    await expect(
      manager.attach({
        ...attachCommand,
        attachmentId: "attachment-5",
      }),
    ).rejects.toThrow(/4 active attachments/i);
  });
});
