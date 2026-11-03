// Execute the unchanged repository against query builders whose awaited results
// are controlled rows. SQL and parameter order come from Source, not a second
// handwritten copy of its builders. This is generation, not database acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { ProjectAutomationRepository } from "../../cantrip_server/src/db/project-automations.ts";
import { projectAutomationWireFixtures } from "./project-automation-wire-fixtures.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const realDate = Date;
const nowMs = realDate.parse("2026-11-03T10:00:00.123Z");
globalThis.Date = class extends realDate {
  constructor(...args) {
    super(...(args.length ? args : [nowMs]));
  }
  static now() {
    return nowMs;
  }
};
const at = new Date(nowMs);
const expected = new Date(nowMs - 60000);
const fixtures = projectAutomationWireFixtures(at.toISOString());
const create = structuredClone(
  fixtures.encryptedProjectAutomationCreateSchema[0],
);
create.schedule = {
  kind: "interval",
  every: 3,
  unit: "minute",
  startsAt: new Date(nowMs - 3600000).toISOString(),
};
for (const [i, field] of [
  "protectedName",
  "protectedPrompt",
  "protectedCondition",
].entries()) {
  create.content[field] = structuredClone(create.content[field]);
  create.content[field].envelope.nonce = Buffer.alloc(12, i + 1).toString(
    "base64url",
  );
}
const row = {
  id: create.id,
  ownerId: "owner",
  projectId: "project",
  chatId: "chat",
  ...create.content,
  schedule: create.schedule,
  enabled: true,
  revision: 19,
  nextRunAt: expected,
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
  createdAt: at,
  updatedAt: at,
};
const run = {
  id: "run",
  fencingToken: 23,
  attemptCount: 27,
  status: "dispatching",
  leaseExpiresAt: new Date(nowMs - 1),
  reasoningEffort: "medium",
};
const selected = {
  automation: row,
  workerId: "worker",
  reasoningEffort: "medium",
};
let labels = [],
  results = [],
  captured = {};
function wrap(builder) {
  return new Proxy(builder, {
    get(target, key) {
      if (key === "then")
        return (resolve, reject) => {
          try {
            const label = labels.shift();
            assert(label, "Unexpected Source query");
            captured[label] = target.toSQL();
            return Promise.resolve(results.shift()).then(resolve, reject);
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
        };
      const value = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args) => wrap(value.apply(target, args))
        : value;
    },
  });
}
const sourceDb = drizzle(
  async () => {
    throw new Error("Unexpected database execution during generation");
  },
  { schema },
);
const db = new Proxy(sourceDb, {
  get(target, key) {
    if (key === "transaction") return (operation) => operation(db);
    const value = Reflect.get(target, key);
    return typeof value === "function"
      ? (...args) => wrap(value.apply(target, args))
      : value;
  },
});
const repository = new ProjectAutomationRepository(db);
async function capture(names, rows, operation) {
  labels = [...names];
  results = [...rows];
  const result = await operation();
  assert.equal(labels.length, 0);
  assert.equal(results.length, 0);
  return result;
}
await capture(["target", "create"], [[{ workerId: "worker" }], [row]], () =>
  repository.create("owner", "project", create),
);
await capture(["list"], [[selected]], () =>
  repository.list("owner", "project"),
);
await capture(["list-worker"], [[selected]], () =>
  repository.listForWorker("owner", "worker"),
);
await capture(["get"], [[selected]], () => repository.get("owner", create.id));
for (let mask = 0; mask < 8; mask++) {
  const content = Object.fromEntries(
    Object.entries(create.content).filter((_, i) => mask & (1 << i)),
  );
  await capture(
    ["update-get", "update-target", `update-${mask}`],
    [[selected], [{ workerId: "worker" }], [row]],
    () => repository.update("owner", create.id, { enabled: true, content }),
  );
}
await capture(["delete"], [[{ id: create.id }]], () =>
  repository.delete("owner", create.id),
);
const input = { revision: 19, scheduledFor: expected.toISOString() };
await capture(
  ["claim-automation", "claim-existing", "claim-insert", "claim-mark"],
  [[selected], [], [run], [row]],
  () =>
    repository.claimDue(
      "owner",
      "worker",
      create.id,
      input,
      "instance",
      120000,
    ),
);
const lease = await capture(
  ["claim-automation", "claim-existing", "claim-renew", "claim-mark"],
  [[selected], [run], [{ ...run, fencingToken: 24 }], [row]],
  () =>
    repository.claimDue(
      "owner",
      "worker",
      create.id,
      input,
      "instance",
      120000,
    ),
);
await capture(["finish-run", "finish-automation"], [[{ id: "run" }], []], () =>
  repository.finishDispatch(lease, "queued", "error 🦀"),
);

const known = new Map();
function identify(value, key, kind = "text") {
  known.set(JSON.stringify(value), { key, kind });
}
for (const [value, key] of [
  [create.id, "id"],
  ["owner", "owner"],
  ["project", "project"],
  ["chat", "chat"],
  ["worker", "worker"],
  ["instance", "instance"],
  ["run", "runId"],
  ["medium", "reasoningEffort"],
  ["queued", "status"],
  ["error 🦀", "error"],
])
  identify(value, key);
for (const [field, value] of Object.entries(create.content))
  identify(JSON.stringify(value), field, "jsonb");
identify(JSON.stringify(create.schedule), "schedule", "jsonb");
for (const [value, key] of [
  [at, "now"],
  [expected, "expected"],
  [new Date(nowMs + 120000), "expires"],
  [lease.nextRunAt, "nextRunAt"],
])
  identify(value.toISOString(), key, "timestamptz");
for (const [value, key] of [
  [19, "revision"],
  [20, "newRevision"],
  [23, "oldFence"],
  [24, "fence"],
  [28, "attempt"],
])
  identify(value, key, "integer");
identify(true, "enabled", "boolean");
const queries = Object.fromEntries(
  Object.entries(captured)
    .filter(([key]) => !key.startsWith("update-g") && key !== "update-target")
    .map(([name, q]) => {
      let uuid = 0;
      const bindings = q.params.map((value) => {
        const key = known.get(JSON.stringify(value));
        if (key)
          return name.startsWith("update-") && key.key === "expected"
            ? { key: "nextRunAt", kind: key.kind }
            : key;
        if (typeof value === "string" && /^[0-9a-f-]{36}$/.test(value))
          return {
            key:
              name === "claim-insert" && uuid++ === 0
                ? "newRunId"
                : "leaseToken",
            kind: "text",
          };
        assert(
          [null, 1, "agent", "dispatching"].includes(value),
          `Unmapped ${name} parameter ${JSON.stringify(value)}`,
        );
        return {
          constant: value,
          kind: typeof value === "number" ? "integer" : "text",
        };
      });
      return [name, { sql: q.sql, bindings }];
    }),
);
globalThis.Date = realDate;
const output = JSON.stringify({ queries }, null, 2) + "\n";
const destination = new URL(
  "../../cantrip_server_rs/src/project_automations/queries.json",
  import.meta.url,
);
if (process.argv.includes("--write")) await writeFile(destination, output);
else
  assert.equal(
    await readFile(destination, "utf8"),
    output,
    "Automation SQL must match the current Source repository",
  );
console.log(JSON.stringify({ queries: Object.keys(queries).length }));
