// Development adapter around the unchanged production admission implementation.
import { WorkerInferenceAdmission } from "../../cantrip_worker/src/inference-admission.ts";
import { LocalNativeInferenceOwnership } from "../../cantrip_worker/src/native-inference-ownership.ts";
import { performance } from "node:perf_hooks";
export const settle = (pending) =>
  Promise.resolve(pending).then(
    (value) => ({ ok: true, value: value ?? null }),
    (error) => ({ ok: false, error: error.message }),
  );
class Gates {
  gates = new Map();
  get(action) {
    if (!this.gates.has(action))
      this.gates.set(action, {
        held: false,
        seen: 0,
        waiters: [],
        barriers: [],
      });
    return this.gates.get(action);
  }
  hold(action, held) {
    const gate = this.get(action);
    gate.held = held;
    if (!held) for (const resolve of gate.waiters.splice(0)) resolve();
  }
  async committed(action) {
    const gate = this.get(action);
    gate.seen++;
    for (const resolve of gate.barriers.splice(0)) resolve();
    if (gate.held) await new Promise((resolve) => gate.waiters.push(resolve));
  }
  async barrier(action, count = 1) {
    const gate = this.get(action);
    while (gate.seen < count)
      await new Promise((resolve) => gate.barriers.push(resolve));
  }
  releaseAll() {
    for (const action of this.gates.keys()) this.hold(action, false);
  }
}
export class Reference {
  runtimes = new Map();
  lifetimes = new Map();
  tickets = new Map();
  leases = new Map();
  pending = new Map();
  trace = { diagnostic: [], errors: [] };
  gates = new Gates();
  now = 0;
  dateNow = Date.now;
  performanceNow = Object.getOwnPropertyDescriptor(performance, "now");
  constructor() {
    Date.now = () => 1_700_000_000_000 + this.now;
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => this.now,
    });
  }
  restore() {
    Date.now = this.dateNow;
    if (this.performanceNow)
      Object.defineProperty(performance, "now", this.performanceNow);
    else delete performance.now;
  }
  async reset() {
    this.gates.releaseAll();
    await this.manager?.close();
    this.manager = null;
    for (const map of [
      this.runtimes,
      this.lifetimes,
      this.tickets,
      this.leases,
      this.pending,
    ])
      map.clear();
    this.trace = { diagnostic: [], errors: [] };
    this.gates = new Gates();
  }
  async call(input) {
    const name = input.name,
      ticket = input.ticket,
      runtime = input.runtime;
    switch (input.op) {
      case "new": {
        await this.reset();
        this.now = 0;
        let owner;
        if (input.binary) {
          const actual = new LocalNativeInferenceOwnership(
            input.binary,
            input.data,
            input.scope,
            (error) => this.trace.errors.push(error.message),
          );
          const gates = this.gates;
          owner = {
            get available() {
              return actual.available;
            },
            onLost: (listener) => actual.onLost(listener),
            prepare: (generation) => actual.prepare(generation),
            close: () => actual.close(),
            retire: async (generation) => {
              await actual.retire(generation);
              await gates.committed("retire");
            },
            journal: async (command) => {
              const result = await actual.journal(command);
              if (command.action === "batch") {
                for (const [index, mutation] of command.commands.entries())
                  if (result?.[index]?.ok === true)
                    await gates.committed(mutation.action);
              } else await gates.committed(command.action);
              return result;
            },
          };
        }
        const recover = input.recover
          ? async (record) => ({
              ...(input.recoveryReplies?.[record.identity.operationId] ?? {
                disposition: "requeued",
                chatId: record.identity.chatId,
              }),
              key: record.key,
            })
          : undefined;
        this.manager = new WorkerInferenceAdmission(
          input.scope,
          (error) => this.trace.errors.push(error.message),
          owner,
          (error) => this.trace.errors.push(error.message),
          recover,
          (event) => this.trace.diagnostic.push(event),
        );
        return null;
      }
      case "advance":
        this.now += input.ms;
        return null;
      case "hold":
        this.gates.hold(input.action, input.held);
        return null;
      case "barrier":
        await this.gates.barrier(input.action, input.count);
        return null;
      case "await":
        return this.pending.get(name).promise.then((result) => {
          if (!result.ok) throw new Error(result.error);
          return result.value;
        });
      case "poll":
        return this.pending.get(name).result ?? { pending: true };
      case "configure":
        return this.manager.configure(input.input);
      case "catalog":
        return this.manager.configureCatalog(input.input);
      case "snapshot":
        return this.manager.snapshot();
      case "trace":
        return this.trace;
      case "recovery":
        return this.manager.recoverySnapshot();
      case "runtime": {
        const value = this.manager.createRuntime();
        this.runtimes.set(name, value);
        return value.generation;
      }
      case "lifetime":
        this.lifetimes.set(
          name,
          this.runtimes.get(runtime).createOperationLifetime(input.operation),
        );
        return null;
      case "lifetime.close":
        this.lifetimes.get(name).close();
        return null;
      case "lifetime.current":
        this.lifetimes.get(name).assertCurrent();
        return null;
      case "request": {
        const lifetime = this.lifetimes.get(input.lifetime);
        this.tickets.set(
          name,
          this.runtimes
            .get(runtime)
            .request({
              ...input.input,
              operationId: lifetime.operationId,
              lifetime,
              providerId: input.provider,
            }),
        );
        return null;
      }
      case "status":
        return this.tickets.get(ticket).status();
      case "cancel":
        this.tickets.get(ticket).cancel();
        return null;
      case "pause":
        return this.tickets.get(ticket).pauseWaiting(input.unforwarded);
      case "unpark":
        this.tickets.get(ticket).resumeWaiting();
        return null;
      case "start":
        this.leases.get(ticket).start();
        return null;
      case "suspend":
        this.leases.get(ticket).suspend();
        return null;
      case "settle":
        this.leases.get(ticket).settle(input.outcome);
        return null;
    }
    let pending;
    switch (input.op) {
      case "prepare":
        pending = this.runtimes.get(runtime).prepareNativeLaunch();
        break;
      case "ready":
        pending = this.tickets.get(ticket).ready.then((lease) => {
          this.leases.set(ticket, lease);
          return null;
        });
        break;
      case "queued":
        pending = this.tickets.get(ticket).queued;
        break;
      case "confirm-pause":
        pending = this.tickets.get(ticket).confirmPause();
        break;
      case "resume":
        pending = this.leases.get(ticket).resume();
        break;
      case "bind":
        pending = this.leases.get(ticket).bindNative(input.execution);
        break;
      case "unused":
        pending = this.tickets.get(ticket).unstartedSource();
        break;
      case "task-unused":
        pending = this.tickets.get(ticket).privateTaskGoalSource();
        break;
      case "task-withdraw":
        pending = this.tickets
          .get(ticket)
          .withdrawTaskGoalBeforeAllow(
            new Error("private task gate withdrawn"),
          );
        break;
      case "withdraw":
        pending = this.tickets
          .get(ticket)
          .withdrawUnstarted(undefined, input.queueRevision);
        break;
      case "exit":
        pending = this.runtimes.get(runtime).exited();
        break;
      case "confirm-owner":
        pending = this.manager.confirmNativeOwnership();
        break;
      case "close":
        pending = this.manager.close();
        break;
      default:
        throw new Error("Unknown admission fixture operation");
    }
    if (input.start) {
      const entry = {};
      entry.promise = settle(pending).then((result) => {
        entry.result = { pending: false, ...result };
        return result;
      });
      this.pending.set(name, entry);
      return null;
    }
    return pending;
  }
}
