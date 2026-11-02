// Actual account selector and durable handoff coordinator, controlled worker.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createManagedChatAccountFailover } from "../../cantrip_server/src/app/runtime/managed-chat-account-failover.ts";
import { installChatRuntimeHandoffRoutes } from "../../cantrip_server/src/app/routes/chat-runtime-handoffs.ts";
import { NativeCommandError } from "../../cantrip_server/src/db/repository/native-command-errors.ts";
import { nativeHandoffFixture } from "./native-handoff-node-fixture.mjs";
const Fastify = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("fastify");
export async function accountFailoverFixture(repository, input) {
  const owner = input.owner,
    chat = input.chat ?? "chat";
  const original =
    input.original ?? (await repository.getChatExecutionContext(owner, chat));
  assert.ok(original, "Actual account preparation context");
  const app = Fastify(),
    events = [],
    commands = [],
    configurations = [];
  let reached, release;
  const seen = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const handoffs = installChatRuntimeHandoffRoutes(app, {
    repository,
    applicationOwnerId: () => owner,
    publishChatInvalidation(chat, resource) {
      events.push({ owner, chat, resource });
    },
    bridge: {
      async request(worker, command, options) {
        commands.push({
          owner: options.ownerId,
          worker,
          command,
          timeoutMs: options.timeoutMs,
        });
        if (input.concurrent) {
          reached();
          await gate;
        }
        if (input.mode === "fail")
          throw new Error("private-worker-handoff-failure");
        if (input.mode === "complete") {
          const ops = repository.nativeRuntimeHandoffs,
            id = command.operationId;
          if (input.checkConfiguration)
            for (const side of ["source", "destination"]) {
              const { configuration: config } = await nativeHandoffFixture(
                repository,
                {
                  action: "configuration",
                  owner,
                  chat,
                  worker,
                  operation: id,
                  side,
                },
              );
              configurations.push({
                side,
                accountId: config.provider.accountId,
                home: config.provider.credentialHomeKey,
                route: config.model.routeId,
                thread: config.threadId,
              });
            }
          await ops.prepared(owner, worker, id, input.prepared);
          await ops.commit(owner, worker, id);
          await ops.finish(owner, worker, id, "completed");
        }
        return null;
      },
    },
  });
  const prepare = createManagedChatAccountFailover({
    repository,
    handoffRuntime: (...args) => handoffs.beginAndWait(...args),
  });
  const outcome = (promise) =>
    promise.then(
      (value) => ({ value }),
      (error) => {
        if (error instanceof NativeCommandError)
          return {
            error: {
              kind: "native-command",
              code: error.code,
              message: error.message,
              status: error.statusCode,
            },
          };
        throw error;
      },
    );
  let timer,
    pendingWhileHeld = false;
  try {
    const first = prepare(
        owner,
        original,
        input.queued ? original.managedInputRevision : input.expected,
      ),
      firstResult = outcome(first),
      results = [];
    if (input.concurrent) {
      await Promise.race([
        seen,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Actual account handoff did not reach the controlled worker",
                ),
              ),
            10000,
          );
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
      const second = input.dropAll ? null : prepare(owner, original, -1);
      if (second)
        assert.equal(
          second,
          first,
          "Concurrent source calls must share the actual in-flight transfer",
        );
      let drained = false;
      const drain = handoffs.drained().then(() => {
        drained = true;
      });
      await Promise.resolve();
      pendingWhileHeld = !drained;
      assert.equal(
        pendingWhileHeld,
        true,
        "Actual handoff still owns its held worker",
      );
      release();
      if (input.dropAll) {
        await firstResult;
        results.push({
          value: await repository.getChatExecutionContext(owner, chat),
        });
      } else if (input.dropFirst) results.push(await outcome(second));
      else results.push(...(await Promise.all([firstResult, outcome(second)])));
      await drain;
    } else results.push(await firstResult);
    if (input.again)
      results.push(await outcome(prepare(owner, original, input.expected)));
    await handoffs.drained();
    return { results, pendingWhileHeld, events, commands, configurations };
  } finally {
    clearTimeout(timer);
    release();
    await handoffs.drained();
    await app.close();
  }
}
