// Bounded, offline conversion of a legacy JavaScript PGlite database.
// Never imported by the native server's serving or background runtime.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pgDumpRaw, removeDumpGuards } from "./pg-dump.mjs";

const { PGlite } = createRequire(
  import.meta.resolve("@electric-sql/pglite-tools/pg_dump"),
)("@electric-sql/pglite");

export async function exportLegacyPglite({ source, output }) {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "cantrip-pglite-export-"),
  );
  let database;
  try {
    // The source must belong to a stopped server. Open only its private copy:
    // even PostgreSQL recovery or SDK boot effects must leave the original safe.
    const copy = path.join(temporary, "database");
    await cp(source, copy, {
      recursive: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_FICLONE,
    });
    database = await PGlite.create(copy);
    const version = (await database.query("SELECT version() AS version"))
      .rows[0].version;
    const raw = await pgDumpRaw({
      pg: database,
      args: ["--no-owner", "--no-privileges"],
    });
    // pg_dump 18 emits this session setting, which PostgreSQL 16 actually
    // rejects with 42704. Adapt only the generated leading prelude: never
    // search/replace inside functions or exported multiline row values.
    const prelude =
      /^((?:--[^\n]*\n|\n)*SET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\n)SET transaction_timeout = 0;\n/;
    let portableTransactionTimeout = false;
    const prepared = removeDumpGuards(raw);
    const sql = prepared.sql.replace(prelude, (_match, prefix) => {
      portableTransactionTimeout = true;
      // Try the actual setting. Only an absent setting is harmless on older
      // PostgreSQL; permission failures and every other error still propagate.
      return (
        prefix +
        "DO $cantrip_dump_settings$ BEGIN PERFORM pg_catalog.set_config('transaction_timeout', '0', false); EXCEPTION WHEN undefined_object THEN NULL; END $cantrip_dump_settings$;\n"
      );
    });
    const bytes = Buffer.from(sql);
    await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
    return {
      format: "postgresql-sql",
      sourceRuntime: "@electric-sql/pglite@0.5.4",
      dumpRuntime: "@electric-sql/pglite-tools@0.4.4",
      portableTransactionTimeout,
      psqlGuardsRemoved: prepared.guardsRemoved,
      version,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await database?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [source, output, ...extra] = process.argv.slice(2);
  if (!source || !output || extra.length)
    throw new Error(
      "Usage: legacy-pglite.mjs <stopped server-db> <new dump.sql>",
    );
  console.log(JSON.stringify(await exportLegacyPglite({ source, output })));
}
