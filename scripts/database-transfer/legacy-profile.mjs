// Bounded offline conversion. Neither this script nor the JavaScript database
// participates in the Rust server's serving or background runtime.
import { execFile } from "node:child_process";
import {
  mkdtemp,
  rm,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { exportLegacyPglite } from "./legacy-pglite.mjs";

const execute = promisify(execFile);
const { PGlite } = createRequire(
  import.meta.resolve("@electric-sql/pglite-tools/pg_dump"),
)("@electric-sql/pglite");
class ConversionFailure extends Error {
  #original;
  constructor(phase, error) {
    super("Legacy profile conversion failed during " + phase + ".");
    this.name = "ConversionFailure";
    this.#original = error;
  }
  original() {
    return this.#original;
  }
}
async function converted(phase, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new ConversionFailure(phase, error);
  }
}
export function exportLegacyProfile(options) {
  return converted("profile export", () => exportProfile(options));
}
async function exportProfile({ source, output, executable }) {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "cantrip-legacy-profile-"),
  );
  try {
    const sql = path.join(temporary, "database.sql");
    const exported = await exportLegacyPglite({
      source: path.join(source, "server-db"),
      output: sql,
    });
    const { stdout } = await execute(
      executable,
      [
        "--migrate-only",
        "--pack-profile",
        source,
        "--profile-sql",
        sql,
        "--export-profile",
        output,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const result = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((value) => value.event === "profile.export.completed");
    if (!result)
      throw new Error("Native profile packer returned no completion receipt.");
    return { ...result.receipt, legacyDatabase: exported };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export function restoreLegacyProfile(options) {
  return converted("profile restore", () => restoreProfile(options));
}
async function restoreProfile({ source, output, executable }) {
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(
    path.join(path.dirname(output), ".cantrip-legacy-profile-"),
  );
  const prepared = path.join(temporary, "profile");
  let database;
  try {
    const { stdout } = await execute(
      executable,
      [
        "--migrate-only",
        "--materialize-profile",
        source,
        "--data-dir",
        prepared,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const result = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((value) => value.event === "profile.materialized");
    if (!result)
      throw new Error("Native profile materializer returned no receipt.");
    const sql = await readFile(
      path.join(prepared, "server-profile-import.sql"),
      "utf8",
    );
    database = await PGlite.create(path.join(prepared, "server-db"));
    await database.transaction(async (transaction) => {
      await transaction.exec(sql);
    });
    await database.close();
    database = undefined;
    await unlink(path.join(prepared, "server-profile-import.sql"));
    await writeFile(
      path.join(prepared, "server-profile-receipt.json"),
      JSON.stringify({
        ...result.receipt,
        databaseMode: "pglite",
        runtime: "legacy-javascript-pglite",
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await execute(
      executable,
      ["--migrate-only", "--publish-profile", prepared, "--data-dir", output],
      { maxBuffer: 1024 * 1024 },
    );
    return {
      ...result.receipt,
      databaseMode: "pglite",
      runtime: "legacy-javascript-pglite",
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
  const [first, ...rest] = process.argv.slice(2);
  const restore = first === "--restore";
  const [source, output, executable, ...extra] = restore
    ? rest
    : [first, ...rest];
  if (!source || !output || !executable || extra.length)
    throw new Error(
      "Usage: legacy-profile.mjs <stopped server data> <new bundle directory> <native server>",
    );
  console.log(
    JSON.stringify(
      await (restore ? restoreLegacyProfile : exportLegacyProfile)({
        source: path.resolve(source),
        output: path.resolve(output),
        executable: path.resolve(executable),
      }),
    ),
  );
}
