// Capture the actual reference count builders; runtime SQL still executes in Rust.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { DesktopUpdateStateRepository } from "../../cantrip_server/src/db/repository/desktop-update-state.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const names = [
  "activeChats",
  "queuedPrompts",
  "terminalServices",
  "projectReplicaJobs",
  "chatRelocationJobs",
  "chatImportJobs",
  "projectAutomationRuns",
  "gitOperations",
  "runConfigurationRuntimes",
];
const pending = [...names];
const queries = {};
function wrap(builder) {
  return new Proxy(builder, {
    get(target, key) {
      if (key === "then")
        return (resolve, reject) => {
          try {
            const name = pending.shift();
            assert.ok(name, "Unexpected Source desktop count query");
            queries[name] = target.toSQL();
            return Promise.resolve([{ count: 0 }]).then(resolve, reject);
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
const source = drizzle(
  async () => {
    throw Error("Unexpected database execution during generation");
  },
  { schema },
);
const database = new Proxy(source, {
  get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function"
      ? (...args) => wrap(value.apply(target, args))
      : value;
  },
});
assert.deepEqual(
  await new DesktopUpdateStateRepository(database).desktopUpdateActiveWork(
    "owner",
  ),
  { activeChats: 0, queuedPrompts: 0, terminalServices: 0, backgroundJobs: 0 },
);
assert.deepEqual(pending, []);
assert.deepEqual(Object.keys(queries), names);
const destination = new URL(
  "../../cantrip_server_rs/contracts/desktop-update-queries.json",
  import.meta.url,
);
const encoded = await format(JSON.stringify({ queries }), {
  ...(await resolveConfig(fileURLToPath(destination))),
  parser: "json",
});
if (process.argv.includes("--write")) await writeFile(destination, encoded);
else
  assert.deepEqual(
    JSON.parse(await readFile(destination, "utf8")),
    JSON.parse(encoded),
    "Desktop count manifest differs from actual Source builders",
  );
console.log(
  JSON.stringify({
    queries: names.length,
    source: "actual DesktopUpdateStateRepository builders",
  }),
);
