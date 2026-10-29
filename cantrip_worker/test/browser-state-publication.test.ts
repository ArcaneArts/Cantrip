import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, it } from "vitest";
import { remoteBrowserServerMessageSchema } from "@cantrip/protocol";
import { BrowserRemoteSurfaceAdapter } from "../src/browser/browser-adapter.js";
import { decodeSurfacePrivateStateForWorker } from "../src/surface-private-state-encryption.js";
import {
  encryptionService,
  ownerId,
  persistentBrowserState,
  serverId,
} from "./helpers/browser-encryption.js";

// Control only Chromium's CDP responses. The adapter, WebSocket client, frame
// pipeline, attachment lifecycle and authenticated state encryption are real.
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-state-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address)
    throw new Error("Missing CDP address");
  const surfaceId = "state-publication";
  const profile = path.join(
    directory,
    "browser",
    "profiles",
    createHash("sha256").update(surfaceId).digest("hex"),
  );
  await mkdir(profile, { recursive: true });
  await writeFile(
    path.join(profile, "DevToolsActivePort"),
    `${address.port}\n/devtools/browser/test\n`,
  );
  let title = "before",
    historyCalls = 0;
  let hold: ((reply: (error?: boolean) => void) => void) | undefined;
  const cursors = new Map<string, () => void>();
  const states: Array<{ attachmentId: string; title: string; url: string }> =
    [];
  let socket: WebSocket;
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      let result: unknown = {};
      if (request.method === "Target.createTarget")
        result = { targetId: "target" };
      if (request.method === "Target.attachToTarget")
        result = { sessionId: "session" };
      if (request.method === "Page.captureScreenshot")
        result = { data: "/9j/2Q==" };
      if (request.method === "Page.getNavigationHistory") {
        historyCalls++;
        result = {
          currentIndex: 0,
          entries: [{ id: 1, title, url: `https://private.example/${title}` }],
        };
        if (hold) {
          const pending = hold;
          hold = undefined;
          pending((error) =>
            connected.send(
              JSON.stringify(
                error
                  ? {
                      id: request.id,
                      error: { code: -32000, message: "Renderer changed" },
                    }
                  : { id: request.id, result },
              ),
            ),
          );
          return;
        }
      }
      connected.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const service = await encryptionService(directory);
  const adapter = new BrowserRemoteSurfaceAdapter({
    dataDirectory: directory,
    executable: "controlled-cdp-fixture",
  });
  adapter.setSurfacePrivateStateService(service);
  const opened: Array<Promise<void>> = [];
  const session = await adapter.open(
    {
      type: "surface.attach",
      surfaceId,
      attachmentId: "first",
      projectId: "project",
      serverId,
      configuration: { kind: "browser", profileId: null },
      stateResource: "browser-row",
      stateRevision: 1,
      stateProtection: await persistentBrowserState({
        revision: 1,
        service,
        surfaceId,
        url: "https://private.example/before",
      }),
      preferredTransport: "websocket",
      viewport: { width: 640, height: 480, devicePixelRatio: 1 },
      desktopStream: null,
    },
    (attachmentId, channel, bytes) => {
      if (channel !== "control") return true;
      const message = remoteBrowserServerMessageSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      if (message.type === "browser-agent-cursor")
        cursors.get(attachmentId)?.();
      if (message.type === "browser-state") {
        opened.push(
          decodeSurfacePrivateStateForWorker({
            ownerId,
            service,
            context: {
              serverId,
              resource: "browser-operation",
              resourceId: surfaceId,
              operationId: message.operationId,
              recordKind: "browser-state",
            },
            opaque: message.stateProtection,
          }).then((state) => {
            states.push({ attachmentId, title: message.title, url: state.url });
          }),
        );
      }
      return true;
    },
  );
  const viewport = { width: 640, height: 480, devicePixelRatio: 1 };
  await session.attach({ id: "first", viewport });
  await Promise.all(opened);
  states.length = 0;
  historyCalls = 0;
  const stop = () =>
    session.handleFrame(
      "first",
      "control",
      new TextEncoder().encode('{"type":"stop"}'),
    );
  return {
    states,
    stop,
    get historyCalls() {
      return historyCalls;
    },
    title(value: string) {
      title = value;
    },
    blockHistory() {
      const entered = Promise.withResolvers<void>();
      let release!: (error?: boolean) => void;
      hold = (reply) => {
        release = reply;
        entered.resolve();
      };
      return {
        entered: entered.promise,
        release: (error?: boolean) => release(error),
      };
    },
    async broadcast() {
      socket!.send(
        JSON.stringify({
          method: "Page.loadEventFired",
          params: {},
          sessionId: "session",
        }),
      );
      // This response follows the event on the same ordered WebSocket.
      await adapter.session(surfaceId)!.command("Runtime.enable");
    },
    attach(id: string) {
      const entered = Promise.withResolvers<void>();
      cursors.set(id, entered.resolve);
      const finished = session.attach({ id, viewport });
      return { entered: entered.promise, finished };
    },
    async flush() {
      await Promise.all(opened);
    },
    async close() {
      await session.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("publishes the latest encrypted state when broadcasts arrive during a history query", async () => {
  const f = await fixture();
  try {
    const held = f.blockHistory();
    const first = f.stop();
    await held.entered;
    f.title("after");
    await f.broadcast();
    await f.broadcast();
    held.release();
    await first;
    await f.flush();
    expect(f.historyCalls).toBe(2);
    expect(f.states).toEqual([
      {
        attachmentId: "first",
        title: "before",
        url: "https://private.example/before",
      },
      {
        attachmentId: "first",
        title: "after",
        url: "https://private.example/after",
      },
    ]);
  } finally {
    await f.close();
  }
});

it("coalesces concurrent attachment refreshes without losing either recipient", async () => {
  const f = await fixture();
  try {
    const held = f.blockHistory();
    const first = f.stop();
    await held.entered;
    f.title("after");
    const second = f.attach("second"),
      third = f.attach("third");
    await Promise.all([second.entered, third.entered]);
    held.release();
    await Promise.all([first, second.finished, third.finished]);
    await f.flush();
    expect(f.historyCalls).toBe(2);
    for (const attachmentId of ["second", "third"]) {
      expect(
        f.states.filter((state) => state.attachmentId === attachmentId).at(-1),
      ).toEqual({
        attachmentId,
        title: "after",
        url: "https://private.example/after",
      });
    }
  } finally {
    await f.close();
  }
});

it("retries a queued broadcast when the preceding renderer history request fails", async () => {
  const f = await fixture();
  try {
    const held = f.blockHistory();
    const first = f.stop();
    await held.entered;
    f.title("recovered");
    await f.broadcast();
    held.release(true);
    await first;
    await f.flush();
    expect(f.historyCalls).toBe(2);
    expect(f.states).toEqual([
      {
        attachmentId: "first",
        title: "recovered",
        url: "https://private.example/recovered",
      },
    ]);
  } finally {
    await f.close();
  }
});

it("can refresh again after a renderer history request fails", async () => {
  const f = await fixture();
  try {
    const held = f.blockHistory();
    const first = f.stop().catch((error: Error) => error);
    await held.entered;
    held.release(true);
    expect(await first).toEqual(new Error("CDP -32000: Renderer changed"));
    f.title("recovered");
    await f.stop();
    await f.flush();
    expect(f.states.at(-1)).toEqual({
      attachmentId: "first",
      title: "recovered",
      url: "https://private.example/recovered",
    });
  } finally {
    await f.close();
  }
});
