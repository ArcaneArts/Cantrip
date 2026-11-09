// Development driver around the production classes and public wire codecs.
import { RedisRelayCoordinator } from "../../tests/reference-node-server/src/coordination/relay-coordinator.ts";
import { CoordinatedWorkerBridge } from "../../tests/reference-node-server/src/workers/coordinated-bridge.ts";
import {
  createWorkerLinkFrame,
  decodeWorkerLinkFrame,
} from "../../packages/protocol/dist/worker-link.js";
import { createInterface } from "node:readline";
let coordinator, bridge;
const peers = new Map(),
  events = [],
  owners = new Map(),
  ownerGates = new Map(),
  eventGates = new Map(),
  coordinationGates = new Map(),
  subscriptions = [];
const record = (value) => events.push(value);
function gate(map, name) {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  map.set(name, { promise, resolve });
}
function release(map, name) {
  map.get(name)?.resolve();
  map.delete(name);
}
function observeError(error) {
  const result = {
    name: error.name,
    class: error.constructor.name,
    message: error.message,
  };
  for (const key of ["code", "requestId", "operation", "workerId", "inference"])
    if (error[key] !== undefined) result[key] = error[key];
  return result;
}
class Socket {
  readyState = 1;
  bufferedAmount = 0;
  listeners = new Map();
  constructor(name, worker, ready) {
    Object.assign(this, { name, worker, ready });
  }
  on(kind, listener) {
    const list = this.listeners.get(kind) ?? [];
    list.push(listener);
    this.listeners.set(kind, list);
  }
  emit(kind, ...args) {
    for (const f of this.listeners.get(kind) ?? []) f(...args);
  }
  send(data) {
    record({
      kind: "worker-output",
      peer: this.name,
      workerId: this.worker,
      ...(typeof data === "string"
        ? { text: data }
        : { bytes: Buffer.from(data).toString("base64") }),
    });
  }
  publishReady() {
    if (this.ready !== undefined) this.send(this.ready);
    return this.readyState === 1;
  }
  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    record({
      kind: "worker-close",
      peer: this.name,
      workerId: this.worker,
      code,
      reason,
    });
    this.emit("close");
  }
  interrupt() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}
async function dispatch(r) {
  switch (r.op) {
    case "init": {
      coordinator = new RedisRelayCoordinator(r.options);
      await coordinator.start();
      for (const operation of ["claimWorker", "refreshWorker", "publish"]) {
        const original = coordinator[operation].bind(coordinator);
        coordinator[operation] = (...args) => {
          const worker =
            operation === "publish"
              ? ""
              : operation === "claimWorker"
                ? args[0].workerId
                : args[0];
          const configured = coordinationGates.get(`${operation}:${worker}`);
          const held =
            configured && (!configured.once || !configured.used)
              ? configured
              : undefined;
          if (!held) return original(...args);
          held.used = true;
          const pause = async () => {
            record({
              kind: "coordination-paused",
              operation,
              workerId: worker,
            });
            await held.promise;
          };
          return (async () => {
            if (!held.after) await pause();
            const value = await original(...args);
            if (held.after) await pause();
            return value;
          })();
        };
      }
      bridge = new CoordinatedWorkerBridge({
        coordinator,
        reconnectGraceMs: r.graceMs ?? 15000,
        resolveOwnerId: async (worker) => {
          record({ kind: "owner-lookup", workerId: worker });
          await ownerGates.get(worker)?.promise;
          return owners.has(worker) ? owners.get(worker) : "owner";
        },
      });
      coordinator.subscribe((message) => {
        if (message.kind === "fixture-barrier")
          record({ kind: "barrier", name: message.name });
      });
      return null;
    }
    case "abandonAttach":
      void dispatch({ ...r, op: "attach" }).catch((error) =>
        record({ kind: "attachment-error", error: error.message }),
      );
      return null;
    case "attach": {
      const socket = new Socket(r.peer, r.workerId, r.ready);
      if (r.open === false) socket.readyState = 3;
      peers.set(r.peer, socket);
      return bridge.attach(r.workerId, socket, r.ownerId, r.continuity);
    }
    case "interrupt":
      peers.get(r.peer).interrupt();
      return null;
    case "receive": {
      const p = peers.get(r.peer);
      p.emit(
        "message",
        r.bytes === undefined
          ? JSON.stringify(r.message)
          : Buffer.from(r.bytes, "base64"),
        r.bytes !== undefined,
      );
      return null;
    }
    case "begin":
    case "delegateBegin": {
      const options = {
        ...r.options,
        ...(r.op === "delegateBegin" ? { forwardInferenceTiming: true } : {}),
        onEvent: async (event) => {
          record({ kind: "command-event", name: r.name, event });
          if (r.failEvent) throw new Error("Controlled event handler failed.");
          await eventGates.get(r.name)?.promise;
        },
        onInferenceTiming: (timing, sequence, providerTimings) =>
          record({
            kind: "inference",
            name: r.name,
            timing,
            sequence,
            ...(providerTimings === undefined ? {} : { providerTimings }),
          }),
      };
      bridge.request(r.workerId, r.command, options).then(
        (result) =>
          record({
            kind: "completion",
            name: r.name,
            ok: true,
            ...(result === undefined ? {} : { result }),
          }),
        (error) =>
          record({
            kind: "completion",
            name: r.name,
            ok: false,
            error: observeError(error),
          }),
      );
      return null;
    }
    case "subscribe": {
      const w = r.workerId;
      subscriptions.push(
        bridge.subscribeWorkerDisconnect(w, () =>
          record({ kind: "disconnect", workerId: w }),
        ),
        bridge.subscribeWorkerOffline(w, () =>
          record({ kind: "offline", workerId: w }),
        ),
        bridge.subscribeNotifications(w, (value) =>
          record({ kind: "notification", workerId: w, value }),
        ),
        bridge.subscribeSurfaceFrames(w, (header, payload) =>
          record({
            kind: "frame",
            workerId: w,
            transport: "surface",
            header,
            payloadBase64: Buffer.from(payload).toString("base64"),
          }),
        ),
        bridge.subscribeTunnelDataPlaneFrames(w, (header, payload) =>
          record({
            kind: "frame",
            workerId: w,
            transport: "tunnel",
            header,
            payloadBase64: Buffer.from(payload).toString("base64"),
          }),
        ),
        bridge.subscribeWorkerLinkFrames(w, (frame) =>
          record({
            kind: "frame",
            workerId: w,
            transport: "worker-link",
            header: frame.header,
            payloadBase64: Buffer.from(frame.payload).toString("base64"),
            bytes: Buffer.from(frame.bytes).toString("base64"),
          }),
        ),
      );
      return null;
    }
    case "sendFrame": {
      const payload = Buffer.from(r.payloadBase64, "base64");
      return r.transport === "surface"
        ? bridge.sendSurfaceFrame(r.workerId, r.header, payload)
        : r.transport === "tunnel"
          ? bridge.sendTunnelDataPlaneFrame(r.workerId, r.header, payload)
          : bridge.sendWorkerLinkFrame(
              r.workerId,
              r.frameBytes === undefined
                ? createWorkerLinkFrame(r.header, payload)
                : decodeWorkerLinkFrame(Buffer.from(r.frameBytes, "base64")),
            );
    }
    case "disconnect":
      bridge.disconnect(r.workerId, r.reason, r.code);
      return null;
    case "connected":
      return bridge.isConnected(r.workerId);
    case "identity":
      return bridge.connectionIdentity(r.workerId);
    case "presence":
      return coordinator.findWorker(r.workerId);
    case "stats":
      return bridge.stats();
    case "barrier":
      await coordinator.publish({
        kind: "fixture-barrier",
        targetInstanceId: r.target,
        name: r.name,
      });
      return null;
    case "coordinationStats":
      return coordinator.stats();
    case "events":
      return events.splice(0);
    case "setOwner":
      owners.set(r.workerId, r.ownerId);
      return null;
    case "gateOwner":
      gate(ownerGates, r.workerId);
      return null;
    case "gateCoord": {
      const key = `${r.operation}:${r.workerId ?? ""}`;
      gate(coordinationGates, key);
      Object.assign(coordinationGates.get(key), {
        after: r.after === true,
        once: r.once !== false,
        used: false,
      });
      return null;
    }
    case "releaseCoord":
      release(coordinationGates, `${r.operation}:${r.workerId ?? ""}`);
      return null;
    case "releaseOwner":
      release(ownerGates, r.workerId);
      return null;
    case "gateEvent":
      gate(eventGates, r.name);
      return null;
    case "releaseEvent":
      release(eventGates, r.name);
      return null;
    case "closeBridge":
      await bridge.close();
      return null;
    case "close":
      await bridge.close();
      await coordinator.close();
      return null;
    default:
      throw new Error(`Unknown bridge fixture operation ${r.op}`);
  }
}
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const r = JSON.parse(line);
    void dispatch(r).then(
      async (result) => {
        await new Promise((resolve) => setImmediate(resolve));
        process.stdout.write(JSON.stringify({ id: r.id, result }) + "\n");
      },
      (error) =>
        process.stdout.write(
          JSON.stringify({ id: r.id, error: error.message }) + "\n",
        ),
    );
  })
  .on("close", () => {
    void (async () => {
      await bridge?.close();
      await coordinator?.close();
    })();
  });
