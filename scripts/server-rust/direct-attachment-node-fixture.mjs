// Development-only driver of the actual reference coordinator. Clock/timers,
// worker acknowledgments and lifecycle observer completions are controlled.
import { createInterface } from "node:readline";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { createServiceLogEmitter } from "../../packages/logging/src/core.ts";
import {
  DirectAttachmentCoordinator,
  DirectAttachmentUnavailableError,
} from "../../cantrip_server/src/direct-attachments/coordinator.ts";
import { WorkerUnavailableError } from "../../cantrip_server/src/workers/bridge.ts";
let coordinator,
  now,
  jitter,
  connected,
  nextTimer = 0;
const saved = new Map(),
  leases = new Map(),
  pending = new Map(),
  behavior = new Map(),
  held = new Map(),
  offline = new Map(),
  timers = new Map();
const commands = [],
  logs = [],
  observers = [];
const randomBytes = crypto.randomBytes;
crypto.randomBytes = (size) =>
  size === 2 ? Buffer.from([jitter >> 8, jitter & 255]) : randomBytes(size);
syncBuiltinESMExports();
Date.now = () => now;
globalThis.setTimeout = (fn, delay) => {
  const timer = { id: ++nextTimer, at: now + delay, unref() {} };
  timers.set(timer, fn);
  return timer;
};
globalThis.clearTimeout = (timer) => timers.delete(timer);
function resolve(value, command) {
  if (typeof value === "string" && value.startsWith("@")) {
    const [name, ...fields] = value.slice(1).split(".");
    return fields.reduce(
      (v, field) => v[field],
      name === "command" ? command : saved.get(name),
    );
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, command));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v, command)]),
    );
  return value;
}
async function controlled(type, command) {
  let spec = behavior.get(type);
  if (spec?.hold)
    spec = await new Promise((release) => {
      const list = held.get(type) ?? [];
      list.push(release);
      held.set(type, list);
    });
  if (spec?.error) {
    const error = spec.unavailable
      ? new WorkerUnavailableError(spec.error)
      : new Error(spec.error);
    if (spec.code) error.code = spec.code;
    throw error;
  }
  if (spec && Object.hasOwn(spec, "response"))
    return resolve(spec.response, command);
  return command?.type === "direct.capability.prepare"
    ? { accepted: true, capabilityId: command.binding.capabilityId }
    : command?.type === "direct.capability.renew"
      ? { renewed: true, leaseExpiresAt: command.leaseExpiresAt }
      : null;
}
const workers = {
  isConnected: () => connected,
  async request(worker, command, options) {
    commands.push({
      worker,
      command,
      owner: options?.ownerId ?? null,
      timeoutMs: options?.timeoutMs,
    });
    return controlled(command.type, command);
  },
  subscribeWorkerOffline(worker, callback) {
    const listeners = offline.get(worker) ?? new Set();
    listeners.add(callback);
    offline.set(worker, listeners);
    return () => listeners.delete(callback);
  },
};
const logger = Object.fromEntries(
  ["debug", "info", "warn", "error"].map((level) => [
    level,
    (_message, event) => logs.push({ level, event }),
  ]),
);
logger.rateLimited = (_key, level, _message, event) =>
  logs.push({ level, event });
const observer = (kind) => async (event) => {
  observers.push({ kind, event });
  await controlled("observer:" + kind, null);
};
async function call(request) {
  try {
    let value = null;
    switch (request.method) {
      case "prepare": {
        const input = { ...request.input };
        for (const field of ["leaseExpiresAt", "maxLeaseExpiresAt"])
          if (Object.hasOwn(input, field))
            input[field] = new Date(input[field]);
        const lease = request.lease
          ? leases.get(request.lease)
          : coordinator.acquirePreparationLease(input);
        if (!lease)
          throw new DirectAttachmentUnavailableError(
            "The owning resource is being revoked.",
          );
        try {
          value = await coordinator.prepare({
            ...input,
            preparationLease: lease,
          });
        } finally {
          if (!request.lease) coordinator.releasePreparationLease(lease);
        }
        break;
      }
      case "acquire": {
        const lease = coordinator.acquirePreparationLease(request.input);
        leases.set(request.name, lease);
        value = Boolean(lease);
        break;
      }
      case "bind":
        value =
          Boolean(leases.get(request.lease)) &&
          coordinator.bindPreparationLease(
            leases.get(request.lease),
            request.kind,
            request.resource,
          );
        break;
      case "active":
        value =
          Boolean(leases.get(request.lease)) &&
          coordinator.preparationLeaseIsActive(leases.get(request.lease));
        break;
      case "release":
        if (leases.get(request.lease))
          coordinator.releasePreparationLease(leases.get(request.lease));
        break;
      case "matches":
        value = coordinator.matches(request.capability, request.authorization);
        break;
      case "activate":
        value = coordinator.recordActivationOutcome(
          request.capability,
          request.authorization,
          request.outcome,
        );
        break;
      case "renew":
        value = await coordinator.renewActiveLease(
          request.capability,
          request.authorization,
        );
        break;
      case "telemetry":
        value = coordinator.recordTelemetry(
          request.capability,
          request.authorization,
          request.input,
        );
        break;
      case "finalTelemetry":
        value = coordinator.recordFinalizedTelemetry(
          request.capability,
          request.authorization,
          request.input,
        );
        break;
      case "tunnelLease":
        value = coordinator.getTunnelLeaseForActivation(
          request.capability,
          request.authorization,
        );
        break;
      case "revoke":
        value = await coordinator.revoke(
          request.capability,
          request.reason,
          request.authorization,
        );
        break;
      case "scope": {
        const mutate = async () => {
          observers.push({ kind: "mutation", event: request.result ?? null });
          await controlled("mutation", null);
          return request.result ?? null;
        };
        if (request.scope === "owner")
          await coordinator.revokeOwner(request.owner);
        else if (request.scope === "session")
          await coordinator.revokeSession(request.account);
        else if (request.scope === "attachment")
          value = await coordinator.mutateAttachment(
            request.attachment,
            mutate,
          );
        else
          value = await coordinator.mutateResource(
            request.owner,
            request.kind,
            request.resource,
            mutate,
          );
        break;
      }
      case "offline":
        for (const callback of offline.get(request.worker) ?? []) callback();
        break;
      case "close":
        await coordinator.close();
        break;
      default:
        throw new Error("Unknown direct fixture method " + request.method);
    }
    if (request.save) saved.set(request.save, value);
    return { ok: value ?? null };
  } catch (cause) {
    return {
      error: {
        class:
          cause instanceof DirectAttachmentUnavailableError
            ? "DirectAttachmentUnavailableError"
            : cause.name,
        message: cause.message,
      },
    };
  }
}
async function dispatch(r) {
  if (r.op === "init") {
    now = r.now;
    jitter = r.jitter ?? 0;
    connected = true;
    const activeLogger = r.policyLogger
      ? createServiceLogEmitter("server", {
          now: () => new Date(now),
          onRecord: (record) => logs.push(record),
        })
      : logger;
    coordinator = new DirectAttachmentCoordinator(workers, activeLogger, {
      onLeaseFinalized: observer("finalized"),
      onLeaseRenewed: observer("renewed"),
    });
    return {};
  }
  if (r.op === "behavior") {
    if (r.value === null) behavior.delete(r.type);
    else behavior.set(r.type, r.value);
    return {};
  }
  if (r.op === "connected") {
    connected = r.value;
    return {};
  }
  if (r.op === "release") {
    for (const release of held.get(r.type) ?? []) release(r.value ?? null);
    held.delete(r.type);
    return {};
  }
  if (r.op === "time" || r.op === "advance") {
    now = r.now;
    if (r.op === "advance")
      for (const [timer, fn] of [...timers].sort((a, b) => a[0].at - b[0].at))
        if (timer.at <= now && timers.delete(timer)) fn();
    return {};
  }
  if (r.op === "snapshot")
    return {
      commands,
      logs,
      observers,
      held: Object.fromEntries([...held].map(([k, v]) => [k, v.length])),
    };
  if (r.op === "join") return pending.get(r.name);
  const request = resolve(r.request);
  if (r.op === "start") {
    pending.set(r.name, call(request));
    return {};
  }
  return call(request);
}
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const result = await dispatch(JSON.parse(line));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    process.stdout.write(JSON.stringify(result ?? null) + "\n");
  } catch (cause) {
    process.stdout.write(JSON.stringify({ driverError: cause.message }) + "\n");
  }
}
