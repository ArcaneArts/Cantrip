// Capture SQL from the actual repository. Branch rows only drive the recorder;
// behavioral acceptance runs the same methods against real databases.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { BrowserRepository } from "../../cantrip_server/src/db/repository/browsers.ts";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { label, state } from "./project-target-state.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy"),
  { getTableColumns } = require("drizzle-orm");
const manifest = {
  columns: Object.keys(getTableColumns(schema.browsers)),
  queries: {},
};
let phase;
const values = {
  id: "browser",
  projectId: "project",
  protectedLabel: label("browser"),
  protectedState: state("browser-state"),
  stateRevision: 1,
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const row = () => manifest.columns.map((key) => values[key]);
const database = new Proxy(
  drizzle(async (query) => {
    if (query.includes('from "browsers"') && query.includes('"projects"')) {
      if (phase === "list") {
        manifest.queries.list = query;
        return { rows: [] };
      }
      manifest.queries.owned = query;
      return { rows: [["browser"]] };
    }
    if (query.startsWith('insert into "browsers"')) {
      manifest.queries.create = query;
      return { rows: [row()] };
    }
    if (query.startsWith('insert into "remote_surfaces"'))
      manifest.queries.surface_create = query;
    if (query.startsWith('update "browsers"')) {
      manifest.queries[phase] = query;
      return { rows: [row()] };
    }
    if (query.startsWith('update "remote_surfaces"'))
      manifest.queries.surface_update = query;
    if (query.startsWith('delete from "remote_surfaces"'))
      manifest.queries.surface_delete = query;
    if (query.startsWith('delete from "browsers"'))
      manifest.queries.delete = query;
    if (query.startsWith("select") && query.includes('from "projects"'))
      return { rows: [["project"]] };
    return { rows: [] };
  }),
  {
    get(target, key) {
      return key === "transaction"
        ? async (fn) => fn(database)
        : Reflect.get(target, key);
    },
  },
);
const repo = new BrowserRepository(database, {
  resolveProjectExecutionPlacement: async () => ({
    placement: { workerId: "worker" },
  }),
  nextProjectTabPosition: async () => 0,
  getRemoteSurfaceExecutionContext: async () => ({
    surface: { kind: "browser", projectId: "project" },
    workerId: "worker",
  }),
});
phase = "list";
await repo.listBrowsers("owner", "project");
phase = "owned";
await repo.browserIsOwnedBy("owner", "browser");
await assert.rejects(
  repo.createBrowser("owner", "project", {
    id: "browser",
    paneId: "fixture-pane",
    titleProtection: label("browser"),
    stateProtection: state("browser-state"),
  }),
);
for (const [key, input] of Object.entries({
  update_title: { titleProtection: label("browser") },
  update_state: {
    expectedStateRevision: 1,
    stateProtection: state("browser-state"),
  },
  update_both: {
    titleProtection: label("browser"),
    expectedStateRevision: 1,
    stateProtection: state("browser-state"),
  },
  update_revision_title: {
    titleProtection: label("browser"),
    expectedStateRevision: 1,
  },
  update_empty: {},
})) {
  phase = key;
  await repo.updateBrowser("owner", "browser", input);
}
phase = "delete";
await repo.deleteBrowser("owner", "browser");
const destination = new URL(
  "../../cantrip_server_rs/src/browsers/queries.json",
  import.meta.url,
);
if (process.argv.includes("--write"))
  await writeFile(destination, JSON.stringify(manifest, null, 2) + "\n");
else if (process.argv.includes("--check"))
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), manifest);
else console.log(JSON.stringify(manifest, null, 2));
