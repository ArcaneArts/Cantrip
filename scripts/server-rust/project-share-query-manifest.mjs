// Record actual repository projections and predicates; no JavaScript server dependency.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { ProjectRepository } from "../../cantrip_server/src/db/repository/projects.ts";
import * as schema from "../../cantrip_server/src/db/schema.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy"),
  { getTableColumns } = require("drizzle-orm");
const manifest = {
  sourceColumns: Object.values(getTableColumns(schema.projectSources)).map(
    (c) => c.name,
  ),
  worktreeColumns: Object.values(getTableColumns(schema.projectWorktrees)).map(
    (c) => c.name,
  ),
  queries: {},
};
let phase;
const database = drizzle(async (sql, parameters) => {
  assert.ok(sql.startsWith("select "));
  const from = sql.indexOf(" from ");
  const projection = sql.slice(7, from);
  assert.ok(!projection.includes(" as "));
  const bindings = parameters.map((value) => ({
    ...(["owner", "project", "worker", "worktree"].includes(value)
      ? { key: value === "worker" || value === "worktree" ? "target" : value }
      : { constant: value }),
    kind:
      typeof value === "boolean"
        ? "boolean"
        : typeof value === "number"
          ? "bigint"
          : "text",
  }));
  manifest.queries[phase] = {
    source: sql,
    array:
      "select jsonb_build_array(" + projection + ")::text" + sql.slice(from),
    bindings,
  };
  return { rows: [] };
});
const repository = new ProjectRepository(database, {});
phase = "source";
await repository.getProjectSource("owner", "project", { workerId: "worker" });
phase = "worktree";
await repository.getProjectWorktreeContext("owner", "project", "worktree");
const destination = new URL(
  "../../cantrip_server_rs/src/project_shares/queries.json",
  import.meta.url,
);
if (process.argv.includes("--write"))
  await writeFile(destination, JSON.stringify(manifest, null, 2) + "\n");
else if (process.argv.includes("--check"))
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), manifest);
else console.log(JSON.stringify(manifest));
