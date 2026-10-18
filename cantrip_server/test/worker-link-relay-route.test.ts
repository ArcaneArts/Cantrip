import type { WorkerLinkSession } from "@cantrip/protocol";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import type WebSocket from "ws";

import { installWorkerLinkSessionRoutes } from "../src/app/routes/worker-link-sessions.js";
import { installRequestPrincipal } from "../src/auth/principal.js";

const origin = "http://127.0.0.1:5173";
const session: WorkerLinkSession = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  identity: {
    serverId: "server-1",
    serverGeneration: "server-generation-1",
    ownerId: "owner-1",
    accountSessionId: "local:owner-1",
    clientInstanceId: "client-instance-1",
    workerId: "worker-1",
    workerProcessGeneration: "worker-generation-1",
  },
  lease: {
    issuedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2099-08-26T12:05:00.000Z",
    absoluteExpiresAt: "2099-08-26T13:00:00.000Z",
  },
  routePolicy: {
    priority: ["local", "lan", "wan", "relay"],
    enabled: ["relay"],
  },
  routeGeneration: 2,
  preferredRoute: "relay",
};

async function fixture(authenticated = true) {
  const app = Fastify();
  const sockets: WebSocket[] = [];
  onTestFinished(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
  });
  await app.register(websocket);
  installRequestPrincipal(
    app,
    authenticated
      ? {
          authMode: "none",
          localUser: {
            id: "owner-1",
            kind: "anonymous",
            displayName: "Test owner",
            email: null,
            role: "owner",
          },
        }
      : { authMode: "password" },
  );
  const sessionForAuthorization = vi.fn<
    (
      sessionId: string,
      authorization: { accountSessionId: string; ownerId: string },
    ) => Promise<WorkerLinkSession | null>
  >(async () => session);
  const attach = vi.fn<
    (active: WorkerLinkSession, socket: WebSocket) => boolean
  >(() => true);
  const registerAuthenticatedSocket = vi.fn(() => true);
  installWorkerLinkSessionRoutes(app, {
    config: { appOrigins: [origin] },
    workerLinks: { sessionForAuthorization },
    workerLinkRelay: { attach },
    registerAuthenticatedSocket,
    registerSessionSocket: vi.fn(),
  } as never);
  await app.ready();
  return {
    attach,
    registerAuthenticatedSocket,
    sessionForAuthorization,
    connect: (query = "routeGeneration=2", requestOrigin = origin) =>
      app.injectWS(
        `/api/worker-links/${session.sessionId}/connect?clientInstanceId=${session.identity.clientInstanceId}&${query}`,
        { headers: { origin: requestOrigin } },
        { onOpen: (socket) => sockets.push(socket) },
      ),
  };
}

describe("WorkerLink relay connection authority", () => {
  it.each(["1", "3", "NaN", "2.5", "", "02"])(
    "rejects generation %s before accepting the WebSocket upgrade",
    async (generation) => {
      const setup = await fixture();
      await expect(
        setup.connect(`routeGeneration=${generation}`),
      ).rejects.toThrow("Unexpected server response: 409");
      expect(setup.attach).not.toHaveBeenCalled();
      expect(setup.registerAuthenticatedSocket).not.toHaveBeenCalled();
    },
  );

  it("accepts current authority and an older client's unversioned handshake", async () => {
    const setup = await fixture();
    await setup.connect();
    await setup.connect("");
    await vi.waitFor(() => expect(setup.attach).toHaveBeenCalledTimes(2));
    expect(
      setup.attach.mock.calls.every(([active]) => active === session),
    ).toBe(true);
    expect(setup.sessionForAuthorization).toHaveBeenCalledWith(
      session.sessionId,
      {
        accountSessionId: "local:owner-1",
        ownerId: "owner-1",
      },
    );
  });

  it("rejects an unauthenticated upgrade", async () => {
    const setup = await fixture(false);
    await expect(setup.connect()).rejects.toThrow(
      "Unexpected server response: 401",
    );
    expect(setup.sessionForAuthorization).not.toHaveBeenCalled();
    expect(setup.attach).not.toHaveBeenCalled();
  });

  it("rejects unavailable authority without attaching or upgrading", async () => {
    const setup = await fixture();
    setup.sessionForAuthorization.mockResolvedValue(null);
    await expect(setup.connect()).rejects.toThrow(
      "Unexpected server response: 404",
    );
    expect(setup.attach).not.toHaveBeenCalled();
  });

  it("rejects a different client instance before upgrading", async () => {
    const setup = await fixture();
    setup.sessionForAuthorization.mockResolvedValue({
      ...session,
      identity: { ...session.identity, clientInstanceId: "other-client" },
    });
    await expect(setup.connect()).rejects.toThrow(
      "Unexpected server response: 404",
    );
    expect(setup.attach).not.toHaveBeenCalled();
  });

  it("rejects a disallowed origin before upgrading", async () => {
    const setup = await fixture();
    await expect(
      setup.connect("routeGeneration=2", "https://other.invalid"),
    ).rejects.toThrow("Unexpected server response: 403");
    expect(setup.attach).not.toHaveBeenCalled();
  });

  it("fences a generation replaced between authorization and attachment", async () => {
    const setup = await fixture();
    setup.sessionForAuthorization
      .mockResolvedValueOnce(session)
      .mockResolvedValue({ ...session, routeGeneration: 3 });
    const socket = await setup.connect();
    const closed = new Promise<number>((resolve) =>
      socket.once("close", resolve),
    );
    expect(await closed).toBe(1008);
    expect(setup.attach).not.toHaveBeenCalled();
  });
});
