// Development-only driver of the actual reference coordinator.
import { createInterface } from "node:readline";
import {
  WorkerLinkCoordinator,
  WorkerLinkUnavailableError,
} from "../../cantrip_server/src/worker-links/coordinator.ts";
let coordinator, now, generation, server;
const commands = [],
  logs = [],
  behavior = new Map(),
  held = new Map(),
  saved = new Map(),
  pending = new Map();
const workers = {
  async request(worker, command, options) {
    commands.push({
      worker,
      command,
      owner: options?.ownerId ?? null,
      timeoutMs: options?.timeoutMs,
    });
    let response = behavior.get(command.type);
    if (response?.hold)
      response = await new Promise((resolve) => {
        const list = held.get(command.type) ?? [];
        list.push(resolve);
        held.set(command.type, list);
      });
    if (response?.error) throw new Error(response.error);
    return response && Object.hasOwn(response, "response")
      ? response.response
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
  subscribeNotifications() {
    return () => {};
  },
};
function resolve(value) {
  if (typeof value === "string" && value.startsWith("@")) {
    const [name, ...fields] = value.slice(1).split(".");
    return fields.reduce((v, f) => v[f], saved.get(name));
  }
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v)]),
    );
  return value;
}
async function call(r) {
  try {
    let value;
    switch (r.method) {
      case "open":
        value = await coordinator.openSession(r.input);
        break;
      case "issue":
        value = await coordinator.issueGrant(r.input);
        break;
      case "renew":
        value = await coordinator.renewSession(r.session, r.duration);
        break;
      case "route":
        value = await coordinator.replaceRoute(r.session, r.route);
        break;
      case "renewGrant":
        value = await coordinator.renewGrant(r.session, r.grant, r.duration);
        break;
      case "revokeGrant":
        value = await coordinator.revokeGrant(r.session, r.grant, r.reason);
        break;
      case "revokeSession":
        value = await coordinator.revokeSession(r.session, r.reason);
        break;
      case "openPeer":
        value = await coordinator.openPeerSession({
          sessionId: r.session,
          route: r.route,
          routeGeneration: r.generation,
        });
        break;
      case "signal":
        value = await coordinator.signalPeer(r.input);
        break;
      case "mailbox":
        value = coordinator.readPeerMailbox(r.session, r.peer, r.input);
        break;
      case "notify":
        value = await workers.notifications?.(r.worker, r.input);
        break;
      case "scope":
        value =
          r.scope === "owner"
            ? await coordinator.revokeOwner(r.owner)
            : r.scope === "account"
              ? await coordinator.revokeAccountSession(r.account)
              : r.attachment === undefined
                ? await coordinator.revokeResource(
                    r.owner,
                    r.kind,
                    r.resource,
                    r.reason,
                  )
                : await coordinator.revokeAttachment(
                    r.owner,
                    r.kind,
                    r.resource,
                    r.attachment,
                    r.reason,
                  );
        break;
      case "offline":
        value = await coordinator.revokeWorker(
          r.worker,
          r.generation,
          r.reason,
        );
        break;
      case "sweep":
        value = await coordinator.sweepExpired();
        break;
      case "stats":
        value = coordinator.stats();
        break;
      case "authorize":
        value = coordinator.sessionForAuthorization(r.session, {
          ownerId: r.owner,
          accountSessionId: r.account,
        });
        break;
      case "configuration":
        value = coordinator.peerConfiguration();
        break;
      case "close":
        value = await coordinator.close();
        break;
      default:
        throw new Error("Unknown coordinator method");
    }
    return { value: value ?? null, rejected: false };
  } catch (error) {
    return {
      rejected: true,
      unavailable: error instanceof WorkerLinkUnavailableError,
      error: error.message,
    };
  }
}
const notificationListeners = new Map();
workers.subscribeNotifications = (worker, listener) => {
  const listeners = notificationListeners.get(worker) ?? new Set();
  listeners.add(listener);
  notificationListeners.set(worker, listeners);
  return () => listeners.delete(listener);
};
workers.notifications = async (worker, value) => {
  for (const listener of notificationListeners.get(worker) ?? [])
    await listener(value);
};
for await (const line of createInterface({ input: process.stdin })) {
  const request = resolve(JSON.parse(line));
  let result;
  switch (request.op) {
    case "init":
      now = request.now;
      generation = request.workerGeneration;
      server = request.serverId;
      coordinator = new WorkerLinkCoordinator(
        workers,
        {
          serverId: server,
          serverGeneration: request.serverGeneration,
          now: () => now,
          sweepIntervalMs: 0,
          peerConfiguration: request.configuration,
          sessionLeaseMs: request.sessionLeaseMs,
          sessionLifetimeMs: request.sessionLifetimeMs,
          maxActiveSessions: request.maxActiveSessions,
        },
        {
          event(level, message, context) {
            logs.push({ level, message, context });
          },
        },
      );
      result = null;
      break;
    case "behavior":
      request.value === null
        ? behavior.delete(request.command)
        : behavior.set(request.command, request.value);
      result = null;
      break;
    case "generation":
      generation = request.value;
      result = null;
      break;
    case "clock":
      now = request.value;
      result = null;
      break;
    case "commands":
      result = commands;
      break;
    case "logs":
      result = logs;
      break;
    case "held":
      result = held.get(request.command)?.length ?? 0;
      break;
    case "release": {
      const list = held.get(request.command) ?? [];
      held.delete(request.command);
      for (const resolve of list) resolve(request.value);
      result = list.length;
      break;
    }
    case "spawn":
      pending.set(request.name, call(request.call));
      result = null;
      break;
    case "await":
      result = await pending.get(request.name);
      pending.delete(request.name);
      break;
    case "call":
      result = await call(request.call);
      break;
    default:
      throw new Error("Unknown fixture operation");
  }
  if (request.save) saved.set(request.save, result.value);
  console.log(JSON.stringify(result));
}
