import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import Fastify from "fastify";
import type { WorkerCommand, CodeRuntimeStatus } from "@cantrip/protocol";
import { CodeTunnelBroker } from "../../src/code/tunnel.js";
import type { ServerRepository } from "../../src/db/repository.js";
import type { WorkerCommandBus } from "../../src/workers/bridge.js";
import { initializeServerLogArchive } from "../../src/logger.js";
import { installServerShutdownHandlers } from "../../src/server-shutdown.js";

const [mode, directory] = process.argv.slice(2);
if (!directory) throw new Error("Missing owned fixture directory");
// A monitor observes Node's original fatal behavior without handling the error.
process.on("uncaughtExceptionMonitor", (_error, origin) => {
  console.error("CANTRIP_SHUTDOWN_UNCAUGHT:" + origin);
});
await initializeServerLogArchive(directory);
const ownerId = "fixture-owner";
const workerId = "fixture-worker";
const serverId = "fixture-server";
const serverControlPlaneGeneration = randomUUID();
const workerProcessGeneration = randomUUID();
const transportIds = [randomUUID(), randomUUID()];
let started = false;
const attempts: Array<{
  type: string;
  transportId?: string;
  acknowledged: boolean;
}> = [];
const managed = new Set<string>();
const cleaned = new Set<string>();
const relays = new Map<
  string,
  { server: ReturnType<typeof createServer>; sockets: Set<Socket> }
>();

function runtime(sessionId: string, incarnation: string): CodeRuntimeStatus {
  return {
    sessionId,
    sessionIncarnationId: incarnation,
    workspaceUri: "file:///fixture/project.code-workspace",
    status: "running",
    editorBuild: {
      version: "fixture",
      upstreamRevision: "a".repeat(40),
      patchset: 1,
      fingerprint: "b".repeat(64),
    },
    processInstanceId: "fixture-process",
    bridgeConnected: true,
    dirtyEditors: [],
    workbench: {
      activeEditor: null,
      git: null,
      conflicts: [],
      savePolicy: "always",
      agentStatus: "idle",
    },
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    lastError: null,
  };
}

const bridge = {
  isConnected: () => !(started && mode === "offline"),
  subscribeWorkerDisconnect: () => () => {},
  subscribeWorkerOffline: () => () => {},
  request: async (_workerId: string, command: WorkerCommand) => {
    const transportId =
      "transportId" in command ? command.transportId : undefined;
    const refused =
      started &&
      (mode === "offline" ||
        (mode === "partial" &&
          transportId === transportIds[1] &&
          (command.type === "code.transport.revoke" ||
            command.type === "code.transport.route.revoke")));
    if (started)
      attempts.push({
        type: command.type,
        transportId,
        acknowledged: !refused,
      });
    if (refused)
      throw new Error(
        mode === "offline"
          ? "fixture worker offline"
          : "fixture remote revocation unacknowledged",
      );
    if (command.type === "code.stop")
      return {
        ...runtime(command.sessionId, command.expectedSessionIncarnationId!),
        bridgeConnected: false,
        processInstanceId: null,
        sessionIncarnationId: null,
        status: "stopped",
      };
    if (command.type === "code.transport.route.authorize") {
      const {
        type: _type,
        expectedSessionIncarnationId,
        routeGrant: _grant,
        ...identity
      } = command;
      return {
        ...identity,
        authorized: true,
        sessionIncarnationId: expectedSessionIncarnationId,
      };
    }
    if (
      command.type === "code.transport.route.revoke" ||
      command.type === "code.transport.revoke"
    ) {
      const { type: _type, ...identity } = command;
      return {
        ...identity,
        revoked: true,
      };
    }
    throw new Error("Unexpected fixture worker command: " + command.type);
  },
} as unknown as WorkerCommandBus;
const broker = new CodeTunnelBroker(bridge);
broker.configureControlPlane(
  {
    encryptionRegistry: {
      findActiveWorkerPrincipal: async () => ({ id: "fixture-principal" }),
      listActiveGrants: async () => ({
        status: "ok",
        grants: [{ component: "tunnel-content", keyRevision: 7 }],
      }),
    },
    registerManagedTunnel: async (
      _ownerId: string,
      _input: unknown,
      { id }: { id: string },
    ) => {
      managed.add(id);
      return { id };
    },
    removeManagedTunnel: async (_ownerId: string, { id }: { id: string }) =>
      managed.delete(id),
  } as unknown as ServerRepository,
  () => {},
  async (_ownerId, transportId) => {
    const relay = relays.get(transportId)!;
    const socketsClosed = [...relay.sockets].map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.destroy();
        }),
    );
    await new Promise<void>((resolve, reject) =>
      relay.server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.all(socketsClosed);
    cleaned.add(transportId);
  },
);

const authorizations: Array<{
  attachmentId: string;
  authSessionId: string;
  ownerId: string;
}> = [];
const relayPorts = [];
for (const [index, transportId] of transportIds.entries()) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  relays.set(transportId, { server, sockets });
  relayPorts.push((server.address() as { port: number }).port);
  const sessionId = randomUUID();
  const authSessionId = "fixture-auth-" + index;
  const attachmentId = randomUUID();
  await broker.createSharedSessionAttachment({
    appearance: "dark",
    attachmentId,
    authSessionId,
    codeTabId: "fixture-code-" + index,
    explorerId: null,
    ownerId,
    projectId: null,
    protectedKeyRevision: 7,
    runtime: runtime(sessionId, randomUUID()),
    serverId,
    serverControlPlaneGeneration,
    sessionId,
    stopSessionOnRelease: true,
    transport: {
      formatVersion: 2,
      transportId,
      protectedRecord: {
        operationId: transportId,
        revision: 1,
        protectedContent: {
          formatVersion: 1,
          domain: "tunnel-content",
          keyRevision: 7,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 7,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      },
    },
    workerId,
    workerProcessGeneration,
    worktreeId: null,
    worktreePath: null,
  });
  authorizations.push({ attachmentId, authSessionId, ownerId });
}

const app = Fastify();
app.get("/ready", async () => broker.sharedTransportStats());
app.addHook("onClose", async () => {
  try {
    await broker.close();
  } finally {
    const renewals = await Promise.all(
      authorizations.map((value) => broker.renewSharedSessionAttachment(value)),
    );
    await writeFile(
      path.join(directory, "closed.json"),
      JSON.stringify({
        stats: broker.sharedTransportStats(),
        renewals,
        attempts,
        managed: managed.size,
        cleaned: cleaned.size,
        listening: [...relays.values()].some(({ server }) => server.listening),
        sockets: [...relays.values()].reduce(
          (count, { sockets }) => count + sockets.size,
          0,
        ),
      }),
    );
  }
});
installServerShutdownHandlers(app);
const address = await app.listen({ host: "127.0.0.1", port: 0 });
started = true;
// Windows has no POSIX SIGTERM delivery; emit the same Node signal event there.
// POSIX tests send the actual OS signal to this owned process.
const input = createInterface({ input: process.stdin, terminal: false });
input.once("line", (line) => {
  if (line === "shutdown") process.emit("SIGTERM");
  input.close();
});
console.log(
  "CANTRIP_SHUTDOWN_READY:" + JSON.stringify({ address, relayPorts }),
);
