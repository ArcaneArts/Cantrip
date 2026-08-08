import { mkdtemp, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  RfbSecurityGateway,
  createVncChallengeResponse,
} from "../src/vnc/rfb-security-gateway.js";
import { VncSecretStore } from "../src/vnc/secret-store.js";
import { VncRemoteSurfaceAdapter } from "../src/vnc/vnc-adapter.js";

describe("VNC worker security gateway", () => {
  it("keeps VNC authentication on the worker and relays post-auth RFB bytes", () => {
    const client: Buffer[] = [];
    const server: Buffer[] = [];
    const onReady = vi.fn();
    const gateway = new RfbSecurityGateway({
      password: "secret",
      sendClient: (bytes) => client.push(Buffer.from(bytes)),
      sendServer: (bytes) => server.push(Buffer.from(bytes)),
      onReady,
      onError: vi.fn(),
    });

    gateway.acceptServer(Buffer.from("RFB 003."));
    gateway.acceptServer(Buffer.from("008\n"));
    expect(Buffer.concat(client).toString("ascii")).toBe("RFB 003.008\n");
    gateway.acceptClient(Buffer.from("RFB 003.008\n"));
    expect(Buffer.concat(server).toString("ascii")).toBe("RFB 003.008\n");

    gateway.acceptServer(Buffer.from([1]));
    gateway.acceptServer(Buffer.from([2]));
    expect(client.at(-1)).toEqual(Buffer.from([1, 1]));
    gateway.acceptClient(Buffer.from([1]));
    expect(server.at(-1)).toEqual(Buffer.from([2]));

    const challenge = Buffer.from([...Array(16).keys()]);
    gateway.acceptServer(challenge.subarray(0, 7));
    gateway.acceptServer(challenge.subarray(7));
    expect(server.at(-1)?.toString("hex")).toBe(
      "ee22539f33a5983ec12f9c2edbc995dd",
    );
    gateway.acceptServer(Buffer.from([0, 0, 0, 0]));
    expect(client.at(-1)).toEqual(Buffer.from([0, 0, 0, 0]));
    expect(onReady).toHaveBeenCalledOnce();

    gateway.acceptClient(Buffer.from([1, 2, 3]));
    gateway.acceptServer(Buffer.from([4, 5, 6]));
    expect(server.at(-1)).toEqual(Buffer.from([1, 2, 3]));
    expect(client.at(-1)).toEqual(Buffer.from([4, 5, 6]));
  });

  it("matches the standard VNC DES challenge response and stores secrets privately", async () => {
    expect(
      createVncChallengeResponse(
        "secret",
        Buffer.from([...Array(16).keys()]),
      ).toString("hex"),
    ).toBe("ee22539f33a5983ec12f9c2edbc995dd");

    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-vnc-secret-"));
    const store = new VncSecretStore(directory);
    const secretRef = await store.set("surface-1", "never-return-this");
    expect(secretRef).not.toContain("surface-1");
    expect(await store.read(secretRef)).toBe("never-return-this");
    if (process.platform !== "win32") {
      expect(
        (await stat(path.join(directory, "vnc-secrets"))).mode & 0o777,
      ).toBe(0o700);
      expect(
        (await stat(path.join(directory, "vnc-secrets", `${secretRef}.secret`)))
          .mode & 0o777,
      ).toBe(0o600);
    }
    await store.delete(secretRef);
    await expect(store.read(secretRef)).rejects.toThrow();
  });

  it("connects a disposable RFB endpoint through the Remote Surface adapter", async () => {
    const receivedAfterHandshake: Buffer[] = [];
    const server = createServer((socket) => {
      let state = 0;
      socket.write("RFB 003.008\n");
      socket.on("data", (bytes) => {
        if (state === 0) {
          expect(bytes.toString("ascii")).toBe("RFB 003.008\n");
          state = 1;
          socket.write(Buffer.from([1, 1]));
        } else if (state === 1) {
          expect(bytes).toEqual(Buffer.from([1]));
          state = 2;
          socket.write(Buffer.from([0, 0, 0, 0]));
        } else {
          receivedAfterHandshake.push(Buffer.from(bytes));
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("RFB fixture did not bind a TCP port.");
    }

    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-vnc-adapter-"),
    );
    const events: Array<{ channel: string; payload: Buffer }> = [];
    const adapter = new VncRemoteSurfaceAdapter(new VncSecretStore(directory));
    const session = await adapter.open(
      {
        type: "surface.attach",
        surfaceId: "desktop-1",
        attachmentId: "attachment-1",
        projectId: "project-1",
        configuration: {
          kind: "vnc",
          host: "127.0.0.1",
          port: address.port,
          displayName: null,
          secretRef: null,
        },
        preferredTransport: "websocket",
        viewport: { width: 800, height: 600, devicePixelRatio: 1 },
      },
      (_attachmentId, channel, payload) =>
        events.push({ channel, payload: Buffer.from(payload) }),
    );
    session.attach({
      id: "attachment-1",
      viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    });

    try {
      await session.handleFrame(
        "attachment-1",
        "control",
        Buffer.from(JSON.stringify({ type: "connect" })),
      );
      await vi.waitFor(() =>
        expect(
          events
            .find(({ channel }) => channel === "rfb")
            ?.payload.toString("ascii"),
        ).toBe("RFB 003.008\n"),
      );
      await session.handleFrame(
        "attachment-1",
        "rfb",
        Buffer.from("RFB 003.008\n"),
      );
      await vi.waitFor(() =>
        expect(
          events.filter(({ channel }) => channel === "rfb").at(-1)?.payload,
        ).toEqual(Buffer.from([1, 1])),
      );
      await session.handleFrame("attachment-1", "rfb", Buffer.from([1]));
      await vi.waitFor(() =>
        expect(
          events
            .filter(({ channel }) => channel === "control")
            .map(({ payload }) => JSON.parse(payload.toString("utf8")))
            .some(({ status }) => status === "connected"),
        ).toBe(true),
      );
      await session.handleFrame("attachment-1", "rfb", Buffer.from([7, 8, 9]));
      await vi.waitFor(() =>
        expect(receivedAfterHandshake).toContainEqual(Buffer.from([7, 8, 9])),
      );
    } finally {
      await session.close();
      server.close();
      await once(server, "close");
    }
  });
});
