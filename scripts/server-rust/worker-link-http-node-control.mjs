// Opt-in facade plumbing. Every lookup executes the actual Redis read before
// its controlled await/error; production reference handlers stay unchanged.
import { RedisRelayCoordinator } from "../../tests/reference-node-server/src/coordination/relay-coordinator.ts";
import { WorkerLinkRelay } from "../../tests/reference-node-server/src/worker-links/relay.ts";
export async function prepareWorkerLinkHttpControl(config) {
  const coordinator = new RedisRelayCoordinator({
    url: config.redisUrl,
    instanceId: "http-node",
    keyPrefix: process.env.CANTRIP_WORKER_LINK_HTTP_NAMESPACE,
  });
  await coordinator.start();
  let plan = {
    session: "",
    nth: 0,
    action: "",
    reads: 0,
    paused: false,
    completed: 0,
  };
  const read = coordinator.findWorkerLinkSession.bind(coordinator);
  coordinator.findWorkerLinkSession = async (session) => {
    const value = await read(session);
    const current = plan;
    if (session !== current.session) return value;
    current.reads++;
    if (current.reads !== current.nth) {
      current.completed++;
      return value;
    }
    if (current.action === "hold") {
      current.paused = true;
      await current.wait;
      current.paused = false;
    }
    current.completed++;
    if (current.action === "fail")
      throw new Error("Controlled authority lookup failure.");
    return value;
  };
  let relay;
  const originalAttach = WorkerLinkRelay.prototype.attach;
  WorkerLinkRelay.prototype.attach = function (...args) {
    const result = Reflect.apply(originalAttach, this, args);
    relay = this;
    return result;
  };
  const lookup = () => ({
    reads: plan.reads,
    paused: plan.paused,
    completed: plan.completed,
  });
  return {
    coordinator,
    install(app) {
      app.post("/__worker_link_http/configure", async (request) => {
        plan.release?.();
        let release;
        const wait = new Promise((resolve) => {
          release = resolve;
        });
        plan = {
          ...request.body,
          reads: 0,
          paused: false,
          completed: 0,
          wait,
          release,
        };
        return lookup();
      });
      app.post("/__worker_link_http/release", async () => {
        plan.release?.();
        return lookup();
      });
      app.get("/__worker_link_http/state", async () => ({
        lookup: lookup(),
        relay: { connections: relay?.stats().connections ?? 0 },
      }));
      app.addHook("preClose", async () => {
        plan.release?.();
      });
      app.addHook("onClose", async () => {
        WorkerLinkRelay.prototype.attach = originalAttach;
      });
    },
  };
}
