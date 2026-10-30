// Bounded, offline conversion of a legacy JavaScript PGlite database.
// Never imported by the native server's serving or background runtime.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";

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
    const file = await pgDump({
      pg: database,
      args: ["--no-owner", "--no-privileges"],
    });
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
    return {
      format: "postgresql-sql",
      sourceRuntime: "@electric-sql/pglite@0.5.4",
      dumpRuntime: "@electric-sql/pglite-tools@0.4.4",
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
