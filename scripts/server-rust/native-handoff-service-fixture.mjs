// Actual Source coordinator; the worker advances actual repositories without
// claiming native file transfer or a real CLI/account migration in this fixture.
import { createRequire } from "node:module";
const Fastify = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("fastify");
import { installChatRuntimeHandoffRoutes } from "../../cantrip_server/src/app/routes/chat-runtime-handoffs.ts";
export async function nativeHandoffServiceFixture(repository, input) {
  const owner = input.owner,
    chat = input.chat ?? "chat",
    operation = input.operation,
    events = [],
    commands = [];
  let wake;
  const waitForPublication = new Promise((resolve) => {
    wake = resolve;
  });
  const method = input.method ?? "start";
  const expectedEvents =
    input.expectedEvents ??
    (["start", "wait", "cancel"].includes(method) ? 2 : 1);
  const app = Fastify();
  const coordinator = installChatRuntimeHandoffRoutes(app, {
    applicationOwnerId: () => owner,
    repository,
    publishChatInvalidation(chat, resource) {
      events.push({ owner, chat, resource });
      if (events.length >= expectedEvents) wake();
    },
    bridge: {
      async request(worker, command, options) {
        commands.push({
          owner: options.ownerId,
          worker,
          command,
          timeoutMs: options.timeoutMs,
        });
        if (input.mode === "fail")
          throw new Error("private-worker-handoff-failure");
        if (input.mode === "complete") {
          if (command.intent === "cancel")
            await repository.nativeRuntimeHandoffs.finish(
              owner,
              worker,
              operation,
              "cancelled",
            );
          else {
            await repository.nativeRuntimeHandoffs.prepared(
              owner,
              worker,
              operation,
              input.prepared,
            );
            await repository.nativeRuntimeHandoffs.commit(
              owner,
              worker,
              operation,
            );
            await repository.nativeRuntimeHandoffs.finish(
              owner,
              worker,
              operation,
              "completed",
            );
          }
        }
        return null;
      },
    },
  });
  try {
    let reply;
    if (method === "wait")
      reply = await coordinator.beginAndWait(owner, chat, input.input);
    else if (method === "reconnect") {
      const barriers = await coordinator.workerConnected(owner, "alpha");
      await Promise.all(barriers.values());
      reply = null;
    } else {
      const path = `/api/chats/${encodeURIComponent(chat)}/runtime-handoffs`;
      const response = await app.inject({
        method: "POST",
        url: method === "start" ? path : `${path}/${operation}/${method}`,
        ...(method === "start" ? { payload: input.input } : {}),
      });
      if (response.statusCode !== 202)
        throw new Error(
          "Source handoff coordinator returned " +
            response.statusCode +
            ": " +
            response.body,
        );
      reply = response.json();
    }
    if (expectedEvents > 0) {
      let timer;
      try {
        await Promise.race([
          waitForPublication,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Handoff publication did not settle")),
              5000,
            );
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      reply,
      state: await repository.nativeRuntimeHandoffs.get(owner, chat, operation),
      events,
      commands,
    };
  } finally {
    await app.close();
  }
}
