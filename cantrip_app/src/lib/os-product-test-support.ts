import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  openAnonymousRecoveryArtifact,
  clearSensitiveBytes,
} from "@cantrip/crypto";
import { workerLinkSessionSchema } from "@cantrip/protocol";
import { WorkerLinkManager } from "./worker-link";
import {
  openWorkerLinkRelayCarrier,
  type WorkerLinkWebSocketLike,
} from "./worker-link-carriers";
const WebSocket = createRequire(
  new URL("../../../cantrip_worker/package.json", import.meta.url),
)("ws");
/** Disposable private product profile only. Never log the returned master key. */
export async function productTestContext(origin: string, recoveryPath: string) {
  const recovery = JSON.parse(await readFile(recoveryPath, "utf8"));
  const master = await openAnonymousRecoveryArtifact(recovery);
  const browserOrigin = "http://127.0.0.1:5179";
  const api = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Origin: browserOrigin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(
        `Product API ${method} ${path} returned ${response.status}: ${await response.text()}`,
      );
    return response.status === 204 ? null : response.json();
  };
  const identity = {
    accountId: null,
    connectionId: null,
    generation: 1,
    incarnationId: randomUUID(),
    serverId: recovery.serverId as string,
    serverUrl: origin,
    userId: recovery.ownerId as string,
  };
  const manager = new WorkerLinkManager({
    createId: randomUUID,
    now: Date.now,
    getIdentity: () => identity,
    createSession: async (workerId, clientInstanceId) =>
      workerLinkSessionSchema.parse(
        await api(`/api/workers/${workerId}/worker-link/sessions`, {
          clientInstanceId,
        }),
      ),
    deleteSession: async (sessionId) => {
      await api(`/api/worker-links/${sessionId}`, undefined, "DELETE");
    },
    renewSession: async (sessionId) =>
      workerLinkSessionSchema.parse(
        await api(`/api/worker-links/${sessionId}/renew`, {}),
      ),
    setRoute: async (sessionId, preferredRoute) =>
      workerLinkSessionSchema.parse(
        await api(`/api/worker-links/${sessionId}/route`, {
          preferredRoute,
        }),
      ),
    recordTelemetry: async (sessionId, routeGeneration, samples) => {
      await api(`/api/worker-links/${sessionId}/telemetry`, {
        routeGeneration,
        samples,
      });
    },
    localSupported: () => false,
    openLocal: async () => {
      throw new Error("This headless client has no native local carrier.");
    },
    openPeer: async () => {
      throw new Error("This headless client has no WebRTC peer carrier.");
    },
    openRelay: (session, _identity, clientInstanceId) =>
      openWorkerLinkRelayCarrier({
        session,
        serverUrl: origin,
        browserOrigin,
        clientInstanceId,
        createWebSocket: (url) =>
          new WebSocket(url, {
            origin: browserOrigin,
          }) as unknown as WorkerLinkWebSocketLike,
      }),
    subscribeEnvironment: () => () => {},
    subscribeIdentity: () => () => {},
  });
  return {
    master,
    recovery,
    api,
    manager,
    async close() {
      try {
        await manager.close();
      } finally {
        clearSensitiveBytes(master);
      }
    },
  };
}
