// Opt-in oracle bootstrap using the unchanged production coordination classes.
import { randomUUID } from "node:crypto";
import { RedisRelayCoordinator } from "../../tests/reference-node-server/src/coordination/relay-coordinator.ts";
import { CoordinatedWorkerBridge } from "../../tests/reference-node-server/src/workers/coordinated-bridge.ts";
import { AppLiveHub } from "../../tests/reference-node-server/src/live/hub.ts";

export async function prepareSharedRuntime(config, database) {
  config.serverInstanceId ??= randomUUID();
  const coordinator = new RedisRelayCoordinator({
    url: config.redisUrl,
    instanceId: config.serverInstanceId,
    maximumInstances: config.coordinationMaxInstances,
    presenceTtlMs: config.coordinationPresenceTtlMs,
  });
  await coordinator.start();
  const workerBridge = new CoordinatedWorkerBridge({
    coordinator,
    resolveOwnerId: (worker) => database.repository.getWorkerOwnerId(worker),
  });
  // Observe the actual hub without changing any publication, return or error.
  // The private fixture route can then drive its real external publisher.
  let hub;
  const publish = AppLiveHub.prototype.publish;
  AppLiveHub.prototype.publish = function (...args) {
    hub = this;
    return Reflect.apply(publish, this, args);
  };
  return {
    coordinator,
    workerBridge,
    install(app) {
      app.post("/__fixture/live", async (request) => {
        const events = [];
        for (const publication of request.body.publications)
          events.push(
            request.body.confirmed
              ? await hub.publishConfirmed(publication)
              : hub.publish(publication),
          );
        return { events };
      });
      app.addHook("onClose", async () => {
        AppLiveHub.prototype.publish = publish;
      });
    },
  };
}
