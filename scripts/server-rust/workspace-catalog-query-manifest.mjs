// Source-derived diagnostics only; native queries still execute before errors
// are annotated. Repository and HTTP acceptance use the actual databases.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { ProjectRepository } from "../../cantrip_server/src/db/repository/projects.ts";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { discoveryWireFixtures } from "./discovery-wire-fixtures.mjs";
import { projectLabel } from "./security-fixtures.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy"),
  { getTableColumns } = require("drizzle-orm");
const fixture =
  discoveryWireFixtures(projectLabel).encryptedProjectWorkspaceCreateSchema;
const manifest = {};
const stop = new Error("Captured source workspace statement");
let phase;
const workspace = {
  id: "workspace",
  ownerId: "owner",
  nameEnvelope: fixture[0].nameProtection.envelope,
  nameBlindIndex: fixture[0].nameProtection.blindIndex,
  nameFormatVersion: 1,
  nameKeyRevision: 1,
  position: 2,
  isDefault: false,
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const database = new Proxy(
  drizzle(async (query) => {
    if (query.includes('from "account_encryption_profiles"'))
      return { rows: [[1]] };
    if (query.startsWith('select "position"')) return { rows: [[1]] };
    if (query.startsWith('insert into "project_workspaces"')) {
      manifest.create = query;
      if (phase === "create") throw stop;
      return {
        rows: [
          Object.keys(getTableColumns(schema.projectWorkspaces)).map(
            (k) => workspace[k],
          ),
        ],
      };
    }
    if (query.startsWith('insert into "project_workspace_storage_profiles"')) {
      manifest[phase] = query;
      throw stop;
    }
    throw new Error("Unexpected actual workspace query: " + query);
  }),
  {
    get(target, key) {
      return key === "transaction"
        ? async (fn) => fn(database)
        : Reflect.get(target, key);
    },
  },
);
const repo = new ProjectRepository(database, {
  ensureDefaultProjectWorkspace: async () => ({ id: "default" }),
});
for (const [key, input, method] of [
  ["create", fixture[0], "createEncryptedProjectWorkspace"],
  ["managedStorage", fixture[0], "createEncryptedProjectWorkspace"],
  ["attachedStorage", fixture[1], "createVerifiedAttachedProjectWorkspace"],
]) {
  phase = key;
  await assert.rejects(
    repo[method]("owner", input),
    (e) => e.cause === stop || e === stop,
  );
}
const destination = new URL(
  "../../cantrip_server_rs/src/projects/workspaces/queries.json",
  import.meta.url,
);
if (process.argv.includes("--write"))
  await writeFile(destination, JSON.stringify(manifest, null, 2) + "\n");
else if (process.argv.includes("--check"))
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), manifest);
else console.log(JSON.stringify(manifest, null, 2));
