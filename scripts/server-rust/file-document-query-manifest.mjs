// Export the actual immutable document repository's SQL and parameter order.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { FileDocumentRepository } from "../../cantrip_server/src/db/repository/file-documents.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const { getTableColumns } = require("drizzle-orm");
const schema = await import("../../cantrip_server/src/db/schema.ts");
const protectedState = {
  classification: { recordKind: "file-document-state" },
  protectedState: {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  },
};
const document = "11111111-1111-4111-8111-111111111111";
const values = {
  id: document,
  projectId: "project",
  workerId: "worker",
  worktreeId: "worktree",
  protectedState,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const manifest = {
  columns: Object.keys(getTableColumns(schema.fileDocuments)),
  queries: {},
};
const row = () => manifest.columns.map((key) => values[key]);
let phase;
const aliases = new Map([
  ["owner", "owner"],
  ["project", "project"],
  [document, "id"],
  ["worker", "worker"],
  ["worktree", "worktree"],
  [JSON.stringify(protectedState), "state"],
]);
const database = new Proxy(
  drizzle(async (source, parameters) => {
    let key, rows;
    if (source.startsWith('insert into "file_documents"')) {
      key = "insert";
      rows = phase === "create" ? [row()] : [];
    } else if (source.endsWith("for update")) {
      key = "target";
      rows = [["worker"]];
    } else if (phase === "list") {
      key = "list";
      rows = [];
    } else if (phase === "get") {
      key = "get";
      rows = [row()];
    } else if (phase === "context") {
      key = "context";
      rows = [[...row(), "/fixture/root"]];
    } else {
      key = "existing";
      rows = [row()];
    }
    const bindings = parameters.map((v) =>
      aliases.has(v)
        ? {
            key: aliases.get(v),
            kind: aliases.get(v) === "state" ? "jsonb" : "text",
          }
        : { constant: v, kind: "text" },
    );
    const query = { source, bindings };
    if (manifest.queries[key]) assert.deepEqual(query, manifest.queries[key]);
    manifest.queries[key] = query;
    return { rows };
  }),
  {
    get(target, key) {
      return key === "transaction"
        ? async (fn) => fn(database)
        : Reflect.get(target, key);
    },
  },
);
const repository = new FileDocumentRepository(database);
phase = "list";
await repository.list("owner", "project");
phase = "get";
await repository.get("owner", document);
for (phase of ["create", "retry"])
  await repository.create("owner", "project", {
    id: document,
    worktreeId: "worktree",
    stateProtection: protectedState,
  });
phase = "context";
await repository.executionContext("owner", document);
const destination = new URL(
  "../../cantrip_server_rs/src/file_documents/queries.json",
  import.meta.url,
);
if (process.argv.includes("--write"))
  await writeFile(destination, JSON.stringify(manifest, null, 2) + "\n");
else if (process.argv.includes("--check"))
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), manifest);
else console.log(JSON.stringify(manifest, null, 2));
