// Opt-in QA observation after the unchanged Source repository promise resolves.
export function observeCompletionPersistence(database) {
  if (process.env.CANTRIP_TEST_COMPLETION_OBSERVATIONS !== "true") return;
  const commands = database.repository.nativeCommands;
  const wrappers = new WeakMap();
  const observed = new Proxy(commands, {
    get(target, key) {
      const method = Reflect.get(target, key, target);
      if (
        !["acknowledgeLogicalCompletion", "deferLogicalCompletion"].includes(
          key,
        ) ||
        typeof method !== "function"
      )
        return method;
      if (!wrappers.has(method))
        wrappers.set(method, async (...args) => {
          const changed = await Reflect.apply(method, target, args);
          console.error(
            JSON.stringify({
              event: "fixture.logical-completion.persisted",
              action: key === "acknowledgeLogicalCompletion" ? "ack" : "defer",
              identity: args.slice(0, 5),
              changed,
              ...(key === "deferLogicalCompletion"
                ? { dueMs: args[5].getTime() }
                : {}),
            }),
          );
          return changed;
        });
      return wrappers.get(method);
    },
  });
  const repository = database.repository;
  database.repository = new Proxy(repository, {
    get(target, key) {
      return key === "nativeCommands"
        ? observed
        : Reflect.get(target, key, target);
    },
  });
}
