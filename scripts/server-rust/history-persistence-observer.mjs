// QA only: observe actual committed acknowledgment/defer promises.
export function observeHistoryPersistence(database) {
  if (process.env.CANTRIP_TEST_HISTORY_OBSERVATIONS !== "true") return;
  const publications = database.repository.nativeHistoryPublications;
  const wrappers = new WeakMap();
  const observed = new Proxy(publications, {
    get(target, key) {
      const method = Reflect.get(target, key, target);
      if (
        !["acknowledge", "defer"].includes(key) ||
        typeof method !== "function"
      )
        return method;
      if (!wrappers.has(method))
        wrappers.set(method, async (...args) => {
          const changed = await Reflect.apply(method, target, args);
          const entry = args[0];
          console.error(
            JSON.stringify({
              event: "fixture.native-history.publication.persisted",
              action: key === "acknowledge" ? "ack" : "defer",
              identity: [entry.ownerId, entry.bindingId, entry.commitId],
              changed,
              ...(key === "defer" ? { dueMs: args[1].getTime() } : {}),
            }),
          );
          return changed;
        });
      return wrappers.get(method);
    },
  });
  database.repository = new Proxy(database.repository, {
    get(target, key) {
      return key === "nativeHistoryPublications"
        ? observed
        : Reflect.get(target, key, target);
    },
  });
}
