// Development-only: actual reference services, real Redis, controlled worker ACKs.
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { RedisRelayCoordinator } from "../../tests/reference-node-server/src/coordination/relay-coordinator.ts";
import {
  WorkerLinkCoordinator,
  WorkerLinkUnavailableError,
} from "../../tests/reference-node-server/src/worker-links/coordinator.ts";
import { WorkerLinkService } from "../../tests/reference-node-server/src/worker-links/service.ts";
import { WorkerLinkRelay } from "../../tests/reference-node-server/src/worker-links/relay.ts";
let coordination, local, service, server, generation, relay, unsubscribeRelay;
const relaySockets = new Map();
class RelaySocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  constructor(name) {
    super();
    this.name = name;
  }
  send() {}
  close(code, reason) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    events.push({ kind: "relay-close", name: this.name, code, reason });
    this.emit("close");
  }
}
async function closeService() {
  unsubscribeRelay?.();
  relay?.close();
  await service?.close();
}
const events = [],
  commands = [],
  behavior = new Map(),
  held = new Map();
const listeners = new Map(),
  subscriptions = new Map(),
  notifications = new Map();
const workers = {
  async request(worker, command, options) {
    commands.push({
      worker,
      command,
      owner: options?.ownerId ?? null,
      timeoutMs: options?.timeoutMs,
    });
    let outcome = behavior.get(command.type);
    if (outcome?.hold)
      outcome = await new Promise((resolve) => {
        const pending = held.get(command.type) ?? [];
        pending.push(resolve);
        held.set(command.type, pending);
      });
    if (outcome?.error) throw new Error(outcome.error);
    return outcome && Object.hasOwn(outcome, "response")
      ? outcome.response
      : command.type === "worker-link.identity.resolve"
        ? {
            serverId: server,
            ownerId: options?.ownerId,
            workerId: worker,
            workerProcessGeneration: generation,
          }
        : { accepted: true };
  },
  subscribeWorkerOffline() {
    return () => {};
  },
  subscribeWorkerLinkFrames() {
    return () => {};
  },
  sendWorkerLinkFrame() {
    return true;
  },
  subscribeNotifications(worker, listener) {
    const set = notifications.get(worker) ?? new Set();
    set.add(listener);
    notifications.set(worker, set);
    return () => set.delete(listener);
  },
};
function subscribe(name, token, spec = {}) {
  let listener = listeners.get(name);
  if (!listener) {
    listener = (scope) => {
      events.push({ kind: "relay-revoke", name, scope });
      for (const key of spec.remove ?? []) {
        subscriptions.get(key)?.();
        subscriptions.delete(key);
      }
      for (const entry of spec.add ?? [])
        subscribe(entry.name, entry.token, entry.spec);
      if (spec.fail)
        throw new Error("Controlled relay revocation listener failed.");
    };
    listeners.set(name, listener);
  }
  subscriptions.set(token, service.subscribeRelayRevocations(listener));
}
async function invoke(r) {
  try {
    let result;
    switch (r.method) {
      case "open":
        result = await service.openSession(r.input);
        break;
      case "authorize":
        result = await service.sessionForAuthorization(r.session, {
          ownerId: r.owner,
          accountSessionId: r.account,
        });
        break;
      case "renew":
        result = await service.renewSession(r.session);
        break;
      case "route":
        result = await service.replaceRoute(r.session, r.route);
        break;
      case "openPeer":
        result = await service.openPeerSession(r.session, r.input);
        break;
      case "signal":
        result = await service.signalPeer(r.session, r.input);
        break;
      case "mailbox":
        result = await service.readPeerMailbox(r.session, r.peer, r.input);
        break;
      case "revokePeer":
        result = await service.revokePeerSession(r.session, r.peer);
        break;
      case "issue":
        result = await service.issueGrant(r.input);
        break;
      case "renewGrant":
        result = await service.renewGrant(r.session, r.grant);
        break;
      case "revokeGrant":
        result = await service.revokeGrant(r.session, r.grant, r.reason);
        break;
      case "revokeSession":
        result = await service.revokeSession(r.session, r.reason);
        break;
      case "revokeAccount":
        result = await service.revokeAccountSession(r.account);
        break;
      case "revokeOwner":
        result = await service.revokeOwner(r.owner);
        break;
      case "revokeResource":
        result = await service.revokeResource(
          r.owner,
          r.kind,
          r.resource,
          r.reason,
        );
        break;
      case "revokeAttachment":
        result = await service.revokeAttachment(
          r.owner,
          r.kind,
          r.resource,
          r.attachment,
          r.reason,
        );
        break;
      case "close":
        result = await closeService();
        break;
      default:
        throw new Error(`Unknown authority method ${r.method}`);
    }
    return { ok: true, result: result ?? null };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error.name,
        class: error.constructor.name,
        message: error.message,
        unavailable: error instanceof WorkerLinkUnavailableError,
      },
    };
  }
}
async function dispatch(r) {
  switch (r.op) {
    case "init": {
      server = r.serverId;
      generation = r.workerGeneration;
      coordination = new RedisRelayCoordinator(r.options);
      await coordination.start();
      local = new WorkerLinkCoordinator(
        workers,
        {
          serverId: server,
          serverGeneration: r.serverGeneration,
          sweepIntervalMs: 0,
          peerConfiguration: r.configuration,
          sessionLeaseMs: r.sessionLeaseMs,
          sessionLifetimeMs: r.sessionLifetimeMs,
        },
        {
          event(level, message, context) {
            events.push({ kind: "log", level, message, context });
          },
        },
      );
      service = new WorkerLinkService(local, coordination);
      relay = new WorkerLinkRelay(workers);
      unsubscribeRelay = service.subscribeRelayRevocations((scope) => {
        if (scope.kind === "session") relay.revokeSession(scope.sessionId);
        else if (scope.kind === "account-session")
          relay.revokeAccountSession(scope.accountSessionId);
        else if (scope.kind === "owner") relay.revokeOwner(scope.ownerId);
      });
      coordination.subscribe((message) => {
        if (message.kind === "fixture-barrier")
          events.push({ kind: "barrier", name: message.name });
      });
      return null;
    }
    case "call":
      return invoke(r.call);
    case "begin":
      void invoke(r.call).then((outcome) =>
        events.push({ kind: "completion", name: r.name, outcome }),
      );
      return null;
    case "abandon":
      // JS promises retain an already-started operation without a waiter.
      void invoke(r.call);
      return null;
    case "abandonServiceResource":
      void service.revokeResource(r.owner, r.kind, r.resource).catch((error) =>
        events.push({
          kind: "abandoned-resource-error",
          error: error.message,
        }),
      );
      return null;
    case "behavior":
      r.value === null
        ? behavior.delete(r.command)
        : behavior.set(r.command, r.value);
      return null;
    case "held":
      return held.get(r.command)?.length ?? 0;
    case "release": {
      const pending = held.get(r.command) ?? [];
      held.delete(r.command);
      for (const resolve of pending) resolve(r.value);
      return pending.length;
    }
    case "commands":
      return commands;
    case "events":
      return events.splice(0);
    case "stats":
      return service.stats();
    case "attachRelay": {
      const socket = new RelaySocket(r.name);
      relaySockets.set(r.name, socket);
      return relay.attach(r.session, socket);
    }
    case "relayOpen":
      return relaySockets.get(r.name)?.readyState === 1;
    case "relayStats":
      return relay.stats();
    case "coordinationStats":
      return coordination.stats();
    case "claim":
      return coordination.findWorkerLinkSession(r.session);
    case "notify":
      for (const listener of notifications.get(r.worker) ?? [])
        await listener(r.input);
      return null;
    case "subscribe":
      subscribe(r.name, r.token, r.spec);
      return null;
    case "unsubscribe":
      subscriptions.get(r.token)?.();
      subscriptions.delete(r.token);
      return null;
    case "publish":
      await coordination.publish(r.payload);
      return null;
    case "barrier":
      await coordination.publish({
        kind: "fixture-barrier",
        targetInstanceId: r.target,
        name: r.name,
      });
      return null;
    case "close":
      await closeService();
      await coordination.close();
      return null;
    default:
      throw new Error(`Unknown fixture operation ${r.op}`);
  }
}
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const r = JSON.parse(line);
    void dispatch(r).then(
      (result) =>
        process.stdout.write(JSON.stringify({ id: r.id, result }) + "\n"),
      (error) =>
        process.stdout.write(
          JSON.stringify({ id: r.id, error: error.message }) + "\n",
        ),
    );
  })
  .on("close", () => {
    void (async () => {
      await closeService();
      await coordination?.close();
    })();
  });
