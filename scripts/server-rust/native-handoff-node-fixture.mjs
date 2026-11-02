import { assertNativeRuntimeWritable } from "../../cantrip_server/src/db/repository/native-runtime-handoff-guard.ts";
import { lockNativeCommandChat } from "../../cantrip_server/src/db/repository/native-command-lock.ts";
import { runtimeHandoffConfiguration } from "../../cantrip_server/src/terminals/runtime-handoff-configuration.ts";
import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
import { nativeHandoffServiceFixture } from "./native-handoff-service-fixture.mjs";
export async function nativeHandoffFixture(repository, input) {
  const operations = repository.nativeRuntimeHandoffs;
  const { owner, chat = "chat", worker = "alpha", operation } = input;
  switch (input.action) {
    case "service":
      return nativeHandoffServiceFixture(repository, input);
    case "configuration": {
      const state = await operations.get(owner, chat, operation);
      const routing = createModelRoutingRuntime({
        repository,
        bridge: { isConnected: () => true },
        app: { log: {} },
        applicationOwnerId: () => owner,
        routeCooldowns: new Map(),
        runtimeCooldownKey: (r) => r.routeId,
        openRouterRuntimeCatalogs: { hydrate: async () => false },
        publishLiveInvalidation() {},
        publishProjectTokenUsageChange() {},
      });
      try {
        return await runtimeHandoffConfiguration(
          owner,
          state,
          input.side ?? "source",
          {
            repository,
            routePairsForConfiguration: routing.routePairsForConfiguration,
          },
        );
      } finally {
        routing.close();
      }
    }
    case "guard":
      return repository.nativeCommands.database.transaction(async (tx) => {
        await lockNativeCommandChat(tx, owner, chat);
        await assertNativeRuntimeWritable(
          tx,
          chat,
          input.runtime,
          input.epoch,
          input.access,
        );
        return null;
      });
    case "begin":
      return operations.begin(owner, chat, input.input);
    case "get":
      return operations.get(owner, chat, operation);
    case "inventory":
      return operations.inventory(owner, chat);
    case "active":
      return operations.activeForWorker(owner, worker);
    case "cancel":
      return operations.requestCancellation(owner, chat, operation);
    case "prepared":
      return operations.prepared(
        owner,
        worker,
        operation,
        input.prepared,
        input.expectedRuntime,
        input.expectedEpoch,
      );
    case "commit":
      return operations.commit(owner, worker, operation);
    case "recover":
      return operations.recover(
        owner,
        worker,
        operation,
        input.side,
        input.expectedBindingId,
        input.recovered,
      );
    case "finish":
      return operations.finish(owner, worker, operation, input.outcome);
    case "failure":
      return operations.failure(owner, worker, operation, input.errorCode);
    default:
      throw new Error("Unknown native handoff fixture action");
  }
}
