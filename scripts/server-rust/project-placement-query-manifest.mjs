// Capture actual Source placement statements for diagnostics after failed SQL.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import * as schema from "../../tests/reference-node-server/src/db/schema.ts";
import { PlacementRepository } from "../../tests/reference-node-server/src/db/repository/placement.ts";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const source = drizzle(
  async () => {
    throw Error("Unexpected generation-time SQL execution");
  },
  { schema },
);
const captured = {};
const tables = {
  projects: "project",
  user_settings: "settings",
  workers: "workers",
  project_sources: "replicas",
};
function wrap(builder) {
  return new Proxy(builder, {
    get(target, key) {
      if (key === "then")
        return (resolve, reject) => {
          const query = target.toSQL();
          const table = query.sql.match(/from "([^"]+)"/u)?.[1];
          const name = tables[table];
          assert.ok(name, query.sql);
          assert.ok(!captured[name], name);
          captured[name] = query;
          return Promise.resolve(
            name === "project"
              ? [
                  {
                    gitCapability: true,
                    id: "fixture-project",
                    originKind: "github",
                    preferredWorkerId: null,
                  },
                ]
              : [],
          ).then(resolve, reject);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args) => wrap(value.apply(target, args))
        : value;
    },
  });
}
const database = new Proxy(source, {
  get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function"
      ? (...args) => wrap(value.apply(target, args))
      : value;
  },
});
await assert.rejects(
  new PlacementRepository(database).resolveProjectExecutionPlacement(
    "fixture-owner",
    "fixture-project",
    "terminal",
    { kind: "project", projectId: "fixture-project" },
    () => false,
  ),
  (error) => error.code === "no-compatible-placement",
);
assert.deepEqual(Object.keys(captured).sort(), Object.values(tables).sort());
const destination = new URL(
  "../../cantrip_server_rs/contracts/project-placement-queries.json",
  import.meta.url,
);
const filename = fileURLToPath(destination);
const output = await format(JSON.stringify(captured), {
  ...(await resolveConfig(filename)),
  filepath: filename,
});
if (process.argv.includes("--write")) await writeFile(destination, output);
else assert.equal(await readFile(destination, "utf8"), output);
console.log(
  JSON.stringify({ capturedSourceQueries: Object.keys(captured).length }),
);
