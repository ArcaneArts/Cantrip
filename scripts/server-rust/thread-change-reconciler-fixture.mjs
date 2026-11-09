import { setImmediate as turn } from "node:timers/promises";
import { ChatThreadChangeReconciler } from "../../tests/reference-node-server/src/chats/thread-change-reconciliation.ts";
export async function threadChangeReconcilerFixture(input) {
  const calls = [],
    accepted = [],
    errors = [],
    receivers = new Map(),
    releases = new Map();
  let started = 0,
    completed = 0;
  const key = (k, r) => JSON.stringify([k, r]);
  for (const [k, r] of input.gates ?? []) {
    let release;
    const promise = new Promise((resolve) => (release = resolve));
    receivers.set(key(k, r), promise);
    releases.set(key(k, r), release);
  }
  const reconciler = new ChatThreadChangeReconciler(
    (error, key) => errors.push({ key, message: error.message }),
    input.limit ?? 4096,
  );
  const wait = async (field, count) => {
    const expires = Date.now() + 15000;
    while ((field === "started" ? started : completed) < count) {
      if (Date.now() >= expires)
        throw new Error("Thread callback did not reach " + field + " " + count);
      await turn();
    }
    await turn();
  };
  try {
    for (const action of input.actions) {
      if (action.kind === "schedule") {
        const note = {
          type: "chat.thread.changed",
          threadId: action.key,
          revision: action.revision,
          changes: action.changes,
        };
        const value = reconciler.schedule(
          action.key,
          note,
          async (observation) => {
            calls.push({ key: action.key, observation });
            started++;
            const id = key(action.key, observation.revision),
              pending = receivers.get(id);
            receivers.delete(id);
            try {
              await pending;
              if ((input.failures ?? []).some(([k, r]) => id === key(k, r)))
                throw new Error("Controlled thread reconciliation failure.");
            } finally {
              completed++;
            }
          },
        );
        accepted.push({
          key: action.key,
          revision: action.revision,
          accepted: value,
        });
      } else if (action.kind === "wait") await wait(action.field, action.count);
      else if (action.kind === "release")
        releases.get(key(action.key, action.revision))();
      else if (action.kind === "clear") reconciler.clear();
      else if (action.kind === "settle") {
        const expires = Date.now() + 15000;
        for (;;) {
          const previous = started;
          await turn();
          if (started === completed && started === previous) break;
          if (Date.now() >= expires)
            throw new Error("Thread callbacks did not settle");
        }
      } else throw new Error("Unknown thread reconciler fixture action");
    }
    const order = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return {
      accepted,
      calls: calls.toSorted(order),
      errors: errors.toSorted(order),
      started,
      completed,
    };
  } finally {
    for (const release of releases.values()) release();
    reconciler.clear();
  }
}
export function threadChangeCases() {
  const s = (key, revision, ...changes) => ({
      kind: "schedule",
      key,
      revision,
      changes,
    }),
    settle = { kind: "settle" },
    wait = (field, count) => ({ kind: "wait", field, count }),
    release = (key, revision) => ({ kind: "release", key, revision });
  return [
    {
      name: "synchronous revisions coalesce their changes and reject duplicates",
      actions: [
        s("a", 1, "goal"),
        s("a", 2, "plan"),
        s("a", 2, "queue"),
        s("a", 3, "queue"),
        settle,
      ],
    },
    {
      name: "inflight work coalesces successors and consumes errors once",
      gates: [["a", 1]],
      failures: [["a", 4]],
      actions: [
        s("a", 1, "goal"),
        wait("started", 1),
        s("a", 2, "plan"),
        s("a", 3, "queue"),
        s("a", 2, "goal"),
        release("a", 1),
        settle,
        s("a", 3, "goal"),
        s("a", 4, "plan"),
        settle,
        s("a", 4, "queue"),
        s("a", 5, "goal"),
        settle,
      ],
    },
    {
      name: "clear preserves inflight ownership and discards only its queued successor",
      gates: [["a", 1]],
      actions: [
        s("a", 1, "goal"),
        wait("started", 1),
        s("a", 2, "queue"),
        { kind: "clear" },
        release("a", 1),
        settle,
        s("a", 1, "plan"),
        settle,
      ],
    },
    {
      name: "capacity evicts oldest inactive entries and stale revisions do not refresh them",
      limit: 2,
      actions: [
        s("a", 1, "goal"),
        settle,
        s("b", 1, "plan"),
        settle,
        s("a", 1, "queue"),
        s("c", 1, "queue"),
        settle,
        s("a", 1, "goal"),
        settle,
        s("b", 1, "plan"),
        settle,
      ],
    },
    {
      name: "capacity never evicts two active observers",
      limit: 2,
      gates: [
        ["a", 1],
        ["b", 1],
      ],
      actions: [
        s("a", 1, "goal"),
        s("b", 1, "plan"),
        wait("started", 2),
        s("c", 1, "queue"),
        release("a", 1),
        release("b", 1),
        settle,
        s("c", 1, "queue"),
        settle,
      ],
    },
    {
      name: "zero capacity does not schedule work",
      limit: 0,
      actions: [s("a", 1, "goal"), settle],
    },
    {
      name: "UTF16 keys retain distinct identities and revisions",
      actions: [
        s("\ud800", 1, "goal"),
        s("�", 1, "plan"),
        s("\ud800", 2, "queue"),
        s("\udfff", 1, "goal"),
        settle,
      ],
    },
  ];
}
